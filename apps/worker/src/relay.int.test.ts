import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { defineEvent, effectJobId } from "@ih/contracts";
import {
  claimDueEvents,
  createDatabase,
  createPool,
  PrismaOutboxWriter,
  withTransaction,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BullEffectEnqueuer, createQueue, createQueueConnection } from "./queue";
import { effectQueueName, type EffectJobData } from "./queues";
import { OutboxRelay, type EffectEnqueuer } from "./relay";
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const appName = "ih-relay-" + randomUUID().slice(0, 8);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: appName,
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "relay-int-test", level: "silent" });
const writer = new PrismaOutboxWriter();
const redis = createQueueConnection(env.QUEUE_REDIS_URL);
const probeQueue = createQueue(effectQueueName("system_probe"), redis);

async function publishProbe(): Promise<string> {
  const probeId = randomUUID();
  return withTransaction(db, (tx) =>
    writer.publish(tx, defineEvent("system.probe", probeId, { probeId })),
  );
}

function relay(enqueuer: EffectEnqueuer, overrides: { leaseMs?: number; owner?: string } = {}) {
  return new OutboxRelay({
    db,
    enqueuer,
    owner: overrides.owner ?? "relay-" + randomUUID().slice(0, 8),
    log,
    batchSize: 50,
    leaseMs: overrides.leaseMs ?? 30_000,
  });
}

/** Records jobs; optionally asserts no transaction of this pool is open during enqueue. */
class RecordingEnqueuer implements EffectEnqueuer {
  readonly jobs: Array<{ data: EffectJobData; jobId: string }> = [];
  openTransactionsSeen = 0;
  failNext = 0;
  async enqueue(data: EffectJobData, jobId: string): Promise<void> {
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%'",
      [appName],
    );
    this.openTransactionsSeen += rows.rows[0].n;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("redis down");
    }
    this.jobs.push({ data, jobId });
  }
}

describe("OutboxRelay (real PostgreSQL + Redis)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    await probeQueue.waitUntilReady();
  });
  beforeEach(async () => {
    // Each test sees only its own events.
    await pool.query(
      "UPDATE consumer_effects SET status = 'skipped', skip_reason = 'test isolation', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status NOT IN ('completed','skipped','dead')",
    );
    await pool.query("UPDATE outbox_events SET completed_at = now() WHERE completed_at IS NULL");
    await probeQueue.obliterate({ force: true });
  });
  afterAll(async () => {
    await probeQueue.obliterate({ force: true });
    await probeQueue.close();
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("enqueues IDs-only jobs with stable IDs and marks effects queued, event dispatched", async () => {
    const eventId = await publishProbe();
    const enqueuer = new BullEffectEnqueuer(redis);
    try {
      expect(await relay(enqueuer).tick()).toEqual({ claimed: 1, dispatched: 1 });
    } finally {
      await enqueuer.close();
    }
    const job = await probeQueue.getJob(effectJobId(eventId, "system_probe"));
    expect(job?.name).toBe("system_probe");
    expect(Object.keys(job!.data).sort()).toEqual(["consumer", "effectId", "eventId"]);
    expect(job!.data.eventId).toBe(eventId);
    const row = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: { effects: true },
    });
    expect(row.dispatchedAt).not.toBeNull();
    expect(row).toMatchObject({ leaseOwner: null, leaseExpiresAt: null, dispatchAttempts: 1 });
    expect(row.effects[0]).toMatchObject({ status: "queued" });
    expect(row.effects[0]!.queuedAt).not.toBeNull();
  });

  it("holds no database transaction open while enqueueing", async () => {
    await publishProbe();
    await publishProbe();
    const enqueuer = new RecordingEnqueuer();
    expect(await relay(enqueuer).tick()).toEqual({ claimed: 2, dispatched: 2 });
    expect(enqueuer.jobs).toHaveLength(2);
    expect(enqueuer.openTransactionsSeen).toBe(0);
  });

  it("lets concurrent relays claim disjoint batches (SKIP LOCKED)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) ids.add(await publishProbe());
    const [a, b] = await Promise.all([
      claimDueEvents(db, "relay-a", 8, 30_000),
      claimDueEvents(db, "relay-b", 8, 30_000),
    ]);
    const claimedA = a.map((event) => event.id);
    const claimedB = b.map((event) => event.id);
    expect(claimedA.filter((id) => claimedB.includes(id))).toEqual([]);
    expect(new Set([...claimedA, ...claimedB])).toEqual(ids);
  });

  it("does not reclaim a live lease; an expired lease is reclaimed and the job ID deduplicates", async () => {
    const eventId = await publishProbe();
    // Relay A claims and enqueues, then "crashes" before marking dispatched.
    const [claim] = await claimDueEvents(db, "relay-a", 10, 200);
    const enqueuer = new BullEffectEnqueuer(redis);
    try {
      const effect = claim!.effects[0]!;
      await enqueuer.enqueue(
        { eventId, effectId: effect.id, consumer: "system_probe" },
        effectJobId(eventId, "system_probe"),
        0,
      );
      expect(await claimDueEvents(db, "relay-b", 10, 30_000)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await relay(enqueuer, { owner: "relay-b" }).tick()).toEqual({
        claimed: 1,
        dispatched: 1,
      });
    } finally {
      await enqueuer.close();
    }
    expect(await probeQueue.getJobCounts("wait", "delayed", "active")).toMatchObject({ wait: 1 });
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.dispatchAttempts).toBe(2);
  });

  it("backs off after an enqueue failure and dispatches on a later pass", async () => {
    const eventId = await publishProbe();
    const enqueuer = new RecordingEnqueuer();
    enqueuer.failNext = 1;
    const owner = "relay-fail";
    expect(await relay(enqueuer, { owner }).tick()).toEqual({ claimed: 1, dispatched: 0 });
    const failed = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: { effects: true },
    });
    expect(failed).toMatchObject({
      lastError: "ENQUEUE_FAILED",
      dispatchedAt: null,
      leaseOwner: owner,
    });
    expect(failed.effects[0]!.status).toBe("pending");
    // Backoff lease: not claimable yet.
    expect(await relay(enqueuer).tick()).toEqual({ claimed: 0, dispatched: 0 });
    await pool.query(
      "UPDATE outbox_events SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [eventId],
    );
    expect(await relay(enqueuer).tick()).toEqual({ claimed: 1, dispatched: 1 });
    const done = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(done).toMatchObject({ lastError: null, leaseOwner: null });
  });

  it("treats a hanging Redis enqueue as a failure instead of stalling the loop", async () => {
    const eventId = await publishProbe();
    const hanging: EffectEnqueuer = { enqueue: () => new Promise<void>(() => {}) };
    const started = Date.now();
    expect(await relay(hanging, { owner: "relay-hang" }).tick()).toEqual({
      claimed: 1,
      dispatched: 0,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row).toMatchObject({ lastError: "ENQUEUE_FAILED", dispatchedAt: null });
  });

  it("never claims completed events (including zero-consumer events)", async () => {
    const orderId = randomUUID();
    await withTransaction(db, (tx) =>
      writer.publish(tx, defineEvent("order.created", orderId, { orderId })),
    );
    expect(await relay(new RecordingEnqueuer()).tick()).toEqual({ claimed: 0, dispatched: 0 });
  });

  it("runs as a loop and stops cleanly", async () => {
    const eventId = await publishProbe();
    const enqueuer = new RecordingEnqueuer();
    const loop = new OutboxRelay({ db, enqueuer, owner: "relay-loop", log, pollMs: 20 });
    loop.start();
    for (let i = 0; i < 100 && enqueuer.jobs.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await loop.stop();
    expect(enqueuer.jobs.map((job) => job.data.eventId)).toEqual([eventId]);
  });
});
