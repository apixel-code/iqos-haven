import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PermanentEffectError, type EffectHandler } from "@ih/application";
import {
  assertTestDatabase,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { defineEvent, effectRetryJobId } from "@ih/contracts";
import {
  claimEffect,
  completeEffect,
  createDatabase,
  createPool,
  EffectLeaseLostError,
  Prisma,
  PrismaOutboxWriter,
  withTransaction,
  type Tx,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner, startEffectWorkers, systemProbeHandler } from "./effects";
import { BullEffectEnqueuer, createQueue, createQueueConnection, testQueuePrefix } from "./queue";
import { effectQueueName, type EffectJobData } from "./queues";
import { OutboxRelay } from "./relay";
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-effects-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "effects-int-test", level: "silent" });
const writer = new PrismaOutboxWriter();
const redis = createQueueConnection(env.QUEUE_REDIS_URL);
const prefix = testQueuePrefix();

/** Stand-in consumer side effect: one row per effect, unique, so a double apply would fail. */
const sideEffects = Prisma.raw("probe_side_effect");
let applied = 0;
const recordingHandler = (
  consumer: "system_probe" | "notification",
  behaviour: (attempt: number) => Promise<void> = async () => undefined,
  maxAttempts = 3,
): EffectHandler<Tx> => ({
  kind: "database",
  consumer,
  maxAttempts,
  async apply(tx, context) {
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO ${sideEffects} (effect_id) VALUES (${context.effectId}::uuid)`,
    );
    applied++;
    await behaviour(context.attempt);
  },
});

async function publishProbe(): Promise<{ eventId: string; data: EffectJobData }> {
  const probeId = randomUUID();
  const eventId = await withTransaction(db, (tx) =>
    writer.publish(tx, defineEvent("system.probe", probeId, { probeId })),
  );
  const effect = await db.consumerEffect.findFirstOrThrow({ where: { eventId } });
  return { eventId, data: { eventId, effectId: effect.id, consumer: "system_probe" } };
}

const runner = (
  handlers: EffectHandler<Tx>[],
  owner = "runner-" + randomUUID().slice(0, 6),
  leaseMs?: number,
) => new EffectRunner({ db, owner, log, handlers, ...(leaseMs ? { leaseMs } : {}) });

const sideEffectCount = async (effectId: string) =>
  (
    await pool.query("SELECT count(*)::int AS n FROM probe_side_effect WHERE effect_id = $1", [
      effectId,
    ])
  ).rows[0].n as number;

describe("EffectRunner (real PostgreSQL + Redis)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    await pool.query("CREATE TABLE probe_side_effect (effect_id uuid PRIMARY KEY)");
  });
  afterAll(async () => {
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("commits the database effect, effect completion and event completion together", async () => {
    const { eventId, data } = await publishProbe();
    expect(await runner([recordingHandler("system_probe")]).run(data)).toBe("completed");
    const event = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: { effects: true },
    });
    expect(event.completedAt).not.toBeNull();
    expect(event.effects[0]).toMatchObject({ status: "completed", attempts: 1, leaseOwner: null });
    expect(await sideEffectCount(data.effectId)).toBe(1);
  });

  it("is safe against duplicate and concurrent deliveries", async () => {
    const { data } = await publishProbe();
    const before = applied;
    const instance = runner([recordingHandler("system_probe", () => delay(100))]);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => instance.run(data)));
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "duplicate")).toHaveLength(4);
    expect(await instance.run(data)).toBe("duplicate");
    expect(applied - before).toBe(1);
    expect(await sideEffectCount(data.effectId)).toBe(1);
  });

  it("rolls back the side effect on a transient failure and schedules a retry", async () => {
    const { eventId, data } = await publishProbe();
    const scheduled: string[] = [];
    const instance = new EffectRunner({
      db,
      owner: "runner-retry",
      log,
      handlers: [
        recordingHandler("system_probe", async () => {
          throw new Error("db hiccup");
        }),
      ],
      retries: { enqueue: async (_data, jobId) => void scheduled.push(jobId) },
    });
    expect(await instance.run(data)).toBe("retry");
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } });
    expect(effect).toMatchObject({
      status: "retry",
      attempts: 1,
      leaseOwner: null,
      lastError: "TRANSIENT",
    });
    expect(effect.dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(scheduled).toEqual([effectRetryJobId(eventId, "system_probe", 1)]);
    expect(await sideEffectCount(data.effectId)).toBe(0);
    // Not due yet: an early duplicate job claims nothing.
    expect(await instance.run(data)).toBe("duplicate");
    await pool.query("UPDATE consumer_effects SET due_at = now() WHERE id = $1", [data.effectId]);
    expect(await runner([recordingHandler("system_probe")]).run(data)).toBe("completed");
    expect(await sideEffectCount(data.effectId)).toBe(1);
  });

  it("sends permanent failures and exhausted budgets to dead with a safe code", async () => {
    const permanent = await publishProbe();
    expect(
      await runner([
        recordingHandler("system_probe", async () => {
          throw new PermanentEffectError("INVALID_PAYLOAD");
        }),
      ]).run(permanent.data),
    ).toBe("dead");
    expect(
      await db.consumerEffect.findUniqueOrThrow({ where: { id: permanent.data.effectId } }),
    ).toMatchObject({
      status: "dead",
      lastError: "INVALID_PAYLOAD",
    });

    const exhausted = await publishProbe();
    const failing = runner([
      recordingHandler(
        "system_probe",
        async () => {
          throw new Error("still down");
        },
        2,
      ),
    ]);
    expect(await failing.run(exhausted.data)).toBe("retry");
    await pool.query("UPDATE consumer_effects SET due_at = now() WHERE id = $1", [
      exhausted.data.effectId,
    ]);
    expect(await failing.run(exhausted.data)).toBe("dead");
    const dead = await db.consumerEffect.findUniqueOrThrow({
      where: { id: exhausted.data.effectId },
    });
    expect(dead).toMatchObject({
      status: "dead",
      attempts: 2,
      lastError: "RETRY_EXHAUSTED:TRANSIENT",
    });
    const event = await db.outboxEvent.findUniqueOrThrow({ where: { id: exhausted.eventId } });
    expect(event.completedAt).toBeNull();
  });

  it("reclaims an expired running lease; the stale runner cannot complete", async () => {
    const { data } = await publishProbe();
    const stale = await claimEffect(db, "runner-stale", data.effectId, "system_probe", 200, 10);
    expect(stale).not.toBeNull();
    expect(await runner([recordingHandler("system_probe")]).run(data)).toBe("duplicate");
    await delay(300);
    expect(await runner([recordingHandler("system_probe")], "runner-new").run(data)).toBe(
      "completed",
    );
    await expect(
      completeEffect(db, "runner-stale", data.effectId, async () => undefined),
    ).rejects.toBeInstanceOf(EffectLeaseLostError);
    expect(await sideEffectCount(data.effectId)).toBe(1);
  });

  it("sends a crash-looping effect to dead once its attempt budget is used", async () => {
    const { data } = await publishProbe();
    // Two runs that "crash" (lease expires without completion or failure record).
    for (let i = 0; i < 2; i++) {
      expect(
        await claimEffect(db, "runner-crash", data.effectId, "system_probe", 100, 2),
      ).not.toBeNull();
      await delay(150);
    }
    expect(await claimEffect(db, "runner-crash", data.effectId, "system_probe", 100, 2)).toBeNull();
    expect(
      await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } }),
    ).toMatchObject({
      status: "dead",
      attempts: 2,
      lastError: "RETRY_EXHAUSTED:LEASE_EXPIRED",
      leaseOwner: null,
    });
  });

  it("only accepts code-like permanent error codes", () => {
    expect(() => new PermanentEffectError("customer +971 rejected")).toThrow(RangeError);
    expect(new PermanentEffectError("RECIPIENT_REJECTED").code).toBe("RECIPIENT_REJECTED");
  });

  it("completes the event when sibling effects finish concurrently", async () => {
    // Two required consumers on one event (catalogue wiring arrives later; insert directly).
    const event = await db.outboxEvent.create({
      data: {
        eventType: "system.probe",
        schemaVersion: 1,
        aggregateType: "system",
        aggregateId: "siblings",
        payload: { probeId: randomUUID() },
        effects: { create: [{ consumer: "system_probe" }, { consumer: "notification" }] },
      },
      include: { effects: true },
    });
    const handlers = [
      recordingHandler("system_probe", () => delay(150)),
      recordingHandler("notification", () => delay(150)),
    ];
    const outcomes = await Promise.all(
      event.effects.map((effect) =>
        runner(handlers).run({
          eventId: event.id,
          effectId: effect.id,
          consumer: effect.consumer as "system_probe" | "notification",
        }),
      ),
    );
    expect(outcomes).toEqual(["completed", "completed"]);
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.completedAt).not.toBeNull();
  });

  it("heartbeats external work and records its receipt", async () => {
    const { data } = await publishProbe();
    const external: EffectHandler<Tx> = {
      kind: "external",
      consumer: "system_probe",
      async perform() {
        await delay(2500);
        return { receipt: "provider-msg-1" };
      },
    };
    expect(await runner([external], "runner-ext", 1500).run(data)).toBe("completed");
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } });
    expect(effect).toMatchObject({ status: "completed", externalReceipt: "provider-msg-1" });
  });

  it("aborts external work when the lease is taken over", async () => {
    const { data } = await publishProbe();
    let aborted = false;
    const external: EffectHandler<Tx> = {
      kind: "external",
      consumer: "system_probe",
      async perform(_context, signal) {
        signal.addEventListener("abort", () => (aborted = true));
        await delay(1800);
        return {};
      },
    };
    const run = runner([external], "runner-ext-a", 1500).run(data);
    await delay(200);
    await pool.query("UPDATE consumer_effects SET lease_owner = 'runner-other' WHERE id = $1", [
      data.effectId,
    ]);
    expect(await run).toBe("lease_lost");
    expect(aborted).toBe(true);
  });

  it("processes a probe end to end: writer → relay → queue → effect worker", async () => {
    const queue = createQueue(effectQueueName("system_probe"), redis, prefix);
    await queue.obliterate({ force: true });
    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    const owner = "e2e-" + randomUUID().slice(0, 6);
    const instance = new EffectRunner({
      db,
      owner,
      log,
      handlers: [systemProbeHandler],
      retries: enqueuer,
    });
    const workers = startEffectWorkers(instance, redis, 2, log, prefix);
    const relay = new OutboxRelay({ db, enqueuer, owner, log, pollMs: 50 });
    try {
      const { eventId } = await publishProbe();
      relay.start();
      let completedAt: Date | null = null;
      for (let i = 0; i < 100 && !completedAt; i++) {
        await delay(50);
        completedAt = (await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }))
          .completedAt;
      }
      expect(completedAt).not.toBeNull();
    } finally {
      await relay.stop();
      await workers.stop();
      await enqueuer.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
