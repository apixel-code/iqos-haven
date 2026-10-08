import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertTestDatabase,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { createPool } from "@ih/db";
import { createLogger } from "@ih/logger";
import { QueueEvents, type Queue, type Job } from "bullmq";
import type Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createQueue, createQueueConnection, QUEUE_PREFIX } from "./queue";
import { startWorker, type WorkerRuntime, type WorkerRuntimeOptions } from "./runtime";
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-int-test",
});
const log = createLogger({ service: "worker-int-test", level: "silent" });
const opened: Redis[] = [];
const runtimes: WorkerRuntime[] = [];
const queues: Queue[] = [];

function connection(): Redis {
  const redis = createQueueConnection(env.QUEUE_REDIS_URL);
  opened.push(redis);
  return redis;
}

/** Unique queue per test: never touches real queues on a shared local Redis. */
function testQueue(): { name: string; queue: Queue } {
  const name = "ih-int-" + randomUUID();
  const queue = createQueue(name, connection());
  queues.push(queue);
  return { name, queue };
}

async function start(overrides: Partial<WorkerRuntimeOptions>): Promise<WorkerRuntime> {
  const runtime = await startWorker({
    appEnv: "test",
    concurrency: 2,
    startupTimeoutMs: 5000,
    log,
    pool,
    connection: connection(),
    onFatal: () => undefined,
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

describe("worker runtime (real Redis + PostgreSQL)", () => {
  beforeAll(async () => {
    const probe = connection();
    await probe.connect();
    expect(await probe.info("memory")).toMatch(/maxmemory_policy:noeviction/);
  });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
    for (const queue of queues.splice(0)) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
  afterAll(async () => {
    for (const redis of opened) redis.disconnect();
    await pool.end();
  });

  it("processes a supported job and deduplicates by stable job ID while it exists", async () => {
    const { name, queue } = testQueue();
    const events = new QueueEvents(name, { connection: connection(), prefix: QUEUE_PREFIX });
    await events.waitUntilReady();
    try {
      await start({ queueName: name });
      const first = await queue.add("healthcheck", {}, { jobId: "probe-1" });
      const duplicate = await queue.add("healthcheck", {}, { jobId: "probe-1" });
      expect(duplicate.id).toBe(first.id);
      expect(await first.waitUntilFinished(events, 5000)).toEqual({ ok: true });
    } finally {
      await events.close();
    }
  });

  it("never runs more than the configured concurrency", async () => {
    const { name, queue } = testQueue();
    let active = 0;
    let peak = 0;
    let done = 0;
    await start({
      queueName: name,
      concurrency: 2,
      processor: async () => {
        peak = Math.max(peak, ++active);
        await delay(100);
        active--;
        done++;
      },
    });
    await queue.addBulk(Array.from({ length: 6 }, (_, i) => ({ name: "slow", data: { i } })));
    for (let i = 0; i < 100 && done < 6; i++) await delay(50);
    expect(done).toBe(6);
    expect(peak).toBe(2);
  });

  it("finishes the active job before stop() resolves", async () => {
    const { name, queue } = testQueue();
    let started = false;
    let finished = false;
    const runtime = await start({
      queueName: name,
      processor: async (_job: Job) => {
        started = true;
        await delay(400);
        finished = true;
      },
    });
    await queue.add("slow", {});
    for (let i = 0; i < 100 && !started; i++) await delay(20);
    expect(started).toBe(true);
    await runtime.stop();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(finished).toBe(true);
  });

  it("refuses to start in production on an evicting queue Redis", async () => {
    const evicting = connection();
    // ioredis uses INFO for its own ready check, so connect before faking the reply.
    await evicting.connect();
    evicting.info = (async () => "maxmemory_policy:allkeys-lru\r\n") as never;
    await expect(
      start({ appEnv: "production", connection: evicting, queueName: "ih-int-" + randomUUID() }),
    ).rejects.toThrow("Unsafe queue configuration");
  });

  it("signals a fatal stop when the policy turns unsafe at runtime", async () => {
    const redis = connection();
    let fatal: string | undefined;
    await start({
      appEnv: "production",
      connection: redis,
      queueName: "ih-int-" + randomUUID(),
      monitorIntervalMs: 50,
      onFatal: (reason) => (fatal = reason),
    });
    redis.info = (async () => "maxmemory_policy:volatile-lru\r\n") as never;
    for (let i = 0; i < 40 && !fatal; i++) await delay(25);
    expect(fatal).toBe("unsafe-queue-policy");
  });
});
