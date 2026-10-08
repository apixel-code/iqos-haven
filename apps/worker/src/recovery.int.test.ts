import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PermanentEffectError } from "@ih/application";
import {
  assertTestDatabase,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { defineEvent, effectJobId, effectReconcileJobId, effectRetryJobId } from "@ih/contracts";
import { dueSlots } from "@ih/domain";
import {
  claimNextRun,
  claimEffect,
  ensureSlots,
  createDatabase,
  createPool,
  EffectNotDeadError,
  findStrandedEffects,
  listDeadEffects,
  PrismaOutboxWriter,
  replayDeadEffect,
  withTransaction,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner, startEffectWorkers, systemProbeHandler } from "./effects";
import { BullEffectEnqueuer, createQueue, createQueueConnection, testQueuePrefix } from "./queue";
import { effectQueueName, type EffectJobData } from "./queues";
import { EffectReconciler } from "./reconciler";
import { OutboxRelay, type EffectEnqueuer } from "./relay";
import { Scheduler } from "./scheduler";
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-recovery-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "recovery-int-test", level: "silent" });
const writer = new PrismaOutboxWriter();
const redis = createQueueConnection(env.QUEUE_REDIS_URL);
const prefix = testQueuePrefix();
const probeQueue = createQueue(effectQueueName("system_probe"), redis, prefix);

async function publishProbe(): Promise<{ eventId: string; data: EffectJobData }> {
  const probeId = randomUUID();
  const eventId = await withTransaction(db, (tx) =>
    writer.publish(tx, defineEvent("system.probe", probeId, { probeId })),
  );
  const effect = await db.consumerEffect.findFirstOrThrow({ where: { eventId } });
  return { eventId, data: { eventId, effectId: effect.id, consumer: "system_probe" } };
}

class Recording implements EffectEnqueuer {
  readonly jobIds: string[] = [];
  async enqueue(_data: EffectJobData, jobId: string): Promise<void> {
    this.jobIds.push(jobId);
  }
}

const age = (sql: string, id: string) => pool.query(sql, [id]);

async function waitForCompletion(eventId: string): Promise<Date | null> {
  for (let i = 0; i < 100; i++) {
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (row.completedAt) return row.completedAt;
    await delay(50);
  }
  return null;
}

describe("recovery: reconciler, replay and schedules (real PostgreSQL + Redis)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    await probeQueue.waitUntilReady();
  });
  afterAll(async () => {
    await probeQueue.obliterate({ force: true });
    await probeQueue.close();
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("M2 gate: recovers from Redis job loss and stays safe under duplicate delivery", async () => {
    const { eventId, data } = await publishProbe();
    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    const owner = "gate-" + randomUUID().slice(0, 6);
    const runner = new EffectRunner({ db, owner, log, handlers: [systemProbeHandler] });
    try {
      // 1. Relay dispatches the effect to Redis.
      await new OutboxRelay({ db, enqueuer, owner, log }).tick();
      expect(await probeQueue.getJob(effectJobId(eventId, "system_probe"))).toBeDefined();
      // 2. Redis loses the job before any worker ran it.
      await probeQueue.obliterate({ force: true });
      // 3. Nothing is processing it; after the stale window the reconciler finds and re-enqueues it.
      await age(
        "UPDATE consumer_effects SET queued_at = now() - interval '10 minutes' WHERE id = $1",
        data.effectId,
      );
      const reconciler = new EffectReconciler({ db, enqueuer, log });
      expect((await reconciler.tick()).requeued).toBeGreaterThanOrEqual(1);
      // 4. Duplicate delivery: the original job ID arrives again as well.
      await enqueuer.enqueue(data, effectJobId(eventId, "system_probe"), 0);
      const workers = startEffectWorkers(runner, redis, 2, log, prefix);
      try {
        expect(await waitForCompletion(eventId)).not.toBeNull();
        // Let the duplicate copies run too; each must find nothing to claim.
        for (let i = 0; i < 40; i++) {
          const counts = await probeQueue.getJobCounts("wait", "active", "delayed");
          if ((counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) break;
          await delay(50);
        }
      } finally {
        await workers.stop();
      }
      const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } });
      expect(effect).toMatchObject({ status: "completed", attempts: 1 });
      // 5. Nothing left to reconcile.
      expect(await findStrandedEffects(db, 1, 100)).toEqual([]);
    } finally {
      await enqueuer.close();
    }
  });

  it("every job ID form is accepted by real BullMQ", async () => {
    const eventId = randomUUID();
    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    const data: EffectJobData = { eventId, effectId: randomUUID(), consumer: "system_probe" };
    try {
      for (const id of [
        effectJobId(eventId, "system_probe"),
        effectRetryJobId(eventId, "system_probe", 3),
        effectReconcileJobId(eventId, "system_probe", 123456),
      ])
        await expect(enqueuer.enqueue(data, id, 60_000)).resolves.toBeUndefined();
    } finally {
      await enqueuer.close();
    }
  });

  it("never re-enqueues live work, but does recover expired and overdue work", async () => {
    const live = await publishProbe();
    const expired = await publishProbe();
    const overdue = await publishProbe();
    const fresh = await publishProbe();
    await claimEffect(db, "runner-live", live.data.effectId, "system_probe", 60_000, 10);
    await claimEffect(db, "runner-dead", expired.data.effectId, "system_probe", 100, 10);
    await pool.query(
      "UPDATE consumer_effects SET status = 'retry', last_error = 'TRANSIENT', due_at = now() - interval '10 minutes' WHERE id = $1",
      [overdue.data.effectId],
    );
    await pool.query(
      "UPDATE consumer_effects SET status = 'retry', last_error = 'TRANSIENT', due_at = now() WHERE id = $1",
      [fresh.data.effectId],
    );
    await delay(150);
    const ids = (await findStrandedEffects(db, 5 * 60_000, 100)).map((effect) => effect.effectId);
    expect(ids).toContain(expired.data.effectId);
    expect(ids).toContain(overdue.data.effectId);
    expect(ids).not.toContain(live.data.effectId);
    expect(ids).not.toContain(fresh.data.effectId);
  });

  it("uses time-bucketed reconcile job IDs so a finished no-op copy cannot block recovery", async () => {
    const { data } = await publishProbe();
    await pool.query(
      "UPDATE consumer_effects SET status = 'queued', queued_at = now() - interval '10 minutes' WHERE id = $1",
      [data.effectId],
    );
    const recording = new Recording();
    const reconciler = new EffectReconciler({ db, enqueuer: recording, log, staleMs: 5 * 60_000 });
    const now = Date.now();
    await reconciler.tick(now);
    await pool.query(
      "UPDATE consumer_effects SET queued_at = now() - interval '10 minutes' WHERE id = $1",
      [data.effectId],
    );
    await reconciler.tick(now + 5 * 60_000);
    const mine = recording.jobIds.filter((id) => id.includes(data.eventId));
    expect(mine).toHaveLength(2);
    expect(new Set(mine).size).toBe(2);
    // The refreshed queued_at restarts the stale clock.
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } });
    expect(Date.now() - effect.queuedAt!.getTime()).toBeLessThan(60_000);
  });

  it("lists dead effects without payloads and replays them with an audit entry", async () => {
    const { eventId, data } = await publishProbe();
    const failing = new EffectRunner({
      db,
      owner: "runner-fail",
      log,
      handlers: [
        {
          kind: "database",
          consumer: "system_probe",
          apply: async () => {
            throw new PermanentEffectError("TEMPLATE_MISSING");
          },
        },
      ],
    });
    expect(await failing.run(data)).toBe("dead");
    const dead = (await listDeadEffects(db, { limit: 50 })).find(
      (row) => row.effectId === data.effectId,
    );
    expect(dead).toMatchObject({
      eventType: "system.probe",
      lastError: "TEMPLATE_MISSING",
      replays: 0,
    });
    expect(Object.keys(dead!)).not.toContain("payload");

    const staffId = "0199c4a2-7b1e-7c3a-9f00-1234567890ab";
    await replayDeadEffect(
      db,
      { requestId: "req-replay", actorId: staffId },
      data.effectId,
      "template deployed",
    );
    const replayed = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effectId } });
    expect(replayed).toMatchObject({ status: "pending", attempts: 0, replays: 1 });
    const audit = await db.auditLog.findFirstOrThrow({ where: { requestId: "req-replay" } });
    expect(audit).toMatchObject({
      action: "effect.replayed",
      actorId: staffId,
      entityId: data.effectId,
      reason: "template deployed",
    });
    await expect(
      replayDeadEffect(db, { requestId: "req-2", actorId: null }, data.effectId, "again"),
    ).rejects.toBeInstanceOf(EffectNotDeadError);
    await expect(
      replayDeadEffect(db, { requestId: "req-3", actorId: null }, data.effectId, "   "),
    ).rejects.toThrow(RangeError);

    // The reconciler enqueues a replayed effect at once; a fixed handler completes it.
    await pool.query(
      "UPDATE outbox_events SET dispatched_at = now() WHERE id = $1 AND dispatched_at IS NULL",
      [eventId],
    );
    const recording = new Recording();
    await new EffectReconciler({ db, enqueuer: recording, log }).tick();
    expect(recording.jobIds.some((id) => id.startsWith(effectJobId(eventId, "system_probe")))).toBe(
      true,
    );
    const fixed = new EffectRunner({
      db,
      owner: "runner-fixed",
      log,
      handlers: [systemProbeHandler],
    });
    expect(await fixed.run(data)).toBe("completed");
    expect(await waitForCompletion(eventId)).not.toBeNull();
  });

  it("completes dispatched events whose effects all finished but completion was missed", async () => {
    const event = await db.outboxEvent.create({
      data: {
        eventType: "system.probe",
        schemaVersion: 1,
        aggregateType: "system",
        aggregateId: "missed",
        payload: { probeId: randomUUID() },
        effects: { create: [{ consumer: "system_probe" }] },
      },
      include: { effects: true },
    });
    await pool.query(
      "UPDATE consumer_effects SET status = 'completed', completed_at = now() WHERE id = $1",
      [event.effects[0]!.id],
    );
    await pool.query("UPDATE outbox_events SET dispatched_at = now() WHERE id = $1", [event.id]);
    expect(
      (await new EffectReconciler({ db, enqueuer: new Recording(), log }).tick()).eventsCompleted,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).completedAt,
    ).not.toBeNull();
  });

  describe("durable scheduler", () => {
    const jobName = () => "test.t" + randomUUID().replaceAll("-", "").slice(0, 12);
    const minute = { kind: "interval", everyMs: 60_000 } as const;

    it("runs each slot once across replicas and catches up missed slots after downtime", async () => {
      const name = jobName();
      const ran: string[] = [];
      const job = {
        name,
        spec: minute,
        catchUp: 3,
        run: async (slot: Date) => void ran.push(slot.toISOString()),
      };
      const a = new Scheduler({ db, owner: "sched-a", log, jobs: [job] });
      const b = new Scheduler({ db, owner: "sched-b", log, jobs: [job] });
      const now = new Date();
      // Before "downtime": two replicas tick at the same time.
      const earlier = new Date(now.getTime() - 10 * 60_000);
      await Promise.all([a.tick(earlier), b.tick(earlier)]);
      expect(ran).toHaveLength(3);
      expect(new Set(ran).size).toBe(3);
      // After 10 minutes down: only the catch-up window (3 latest slots) runs, each once.
      await Promise.all([a.tick(now), b.tick(now)]);
      expect(ran).toHaveLength(6);
      expect(new Set(ran).size).toBe(6);
      // Each slot exactly once; order is only guaranteed within one replica's claim batch.
      const expected = [
        ...dueSlots(minute, new Date(now.getTime() - 10 * 60_000), 3),
        ...dueSlots(minute, now, 3),
      ].map((slot) => slot.toISOString());
      expect([...ran].sort()).toEqual(expected.sort());
      // Ticking again finds nothing new.
      await a.tick(now);
      expect(ran).toHaveLength(6);
      const rows = await db.scheduledRun.findMany({ where: { jobName: name } });
      expect(rows.every((row) => row.status === "completed" && row.attempts === 1)).toBe(true);
    });

    it("retries a failing slot and marks it failed after its budget", async () => {
      const name = jobName();
      let calls = 0;
      const scheduler = new Scheduler({
        db,
        owner: "sched-fail",
        log,
        jobs: [
          {
            name,
            spec: minute,
            catchUp: 1,
            maxAttempts: 2,
            run: async () => {
              calls++;
              throw new Error("down");
            },
          },
        ],
      });
      const now = new Date();
      expect(await scheduler.tick(now)).toEqual({ completed: 0, failed: 0 });
      expect(await scheduler.tick(now)).toEqual({ completed: 0, failed: 1 });
      expect(await scheduler.tick(now)).toEqual({ completed: 0, failed: 0 });
      expect(calls).toBe(2);
      const [row] = await db.scheduledRun.findMany({ where: { jobName: name } });
      expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "RUN_FAILED" });
    });

    it("leases each slot only when it starts, so slow runs are never double-run", async () => {
      const name = jobName();
      const ran: string[] = [];
      const job = {
        name,
        spec: minute,
        catchUp: 3,
        run: async (slot: Date) => {
          ran.push(slot.toISOString());
          await delay(300);
        },
      };
      const a = new Scheduler({ db, owner: "sched-slow-a", log, leaseMs: 1500, jobs: [job] });
      const b = new Scheduler({ db, owner: "sched-slow-b", log, leaseMs: 1500, jobs: [job] });
      const now = new Date();
      const first = a.tick(now);
      // Replica B arrives while A is still working through its slots.
      await delay(450);
      await Promise.all([first, b.tick(now)]);
      expect([...ran].sort()).toEqual(dueSlots(minute, now, 3).map((slot) => slot.toISOString()));
    });

    it("fails a slot that keeps crashing its runner once the budget is used", async () => {
      const name = jobName();
      await ensureSlots(db, name, dueSlots(minute, new Date(), 1));
      for (let i = 0; i < 2; i++) {
        expect(await claimNextRun(db, "sched-crashloop", name, 100, 2)).not.toBeNull();
        await delay(150);
      }
      expect(await claimNextRun(db, "sched-crashloop", name, 100, 2)).toBeNull();
      const [row] = await db.scheduledRun.findMany({ where: { jobName: name } });
      expect(row).toMatchObject({
        status: "failed",
        attempts: 2,
        lastError: "RETRY_EXHAUSTED:LEASE_EXPIRED",
        leaseOwner: null,
      });
    });

    it("reclaims a slot whose runner crashed mid-run", async () => {
      const name = jobName();
      const ran: string[] = [];
      const job = {
        name,
        spec: minute,
        catchUp: 1,
        run: async (slot: Date) => void ran.push(slot.toISOString()),
      };
      // A replica claims the slot with a short lease and dies without completing or failing it.
      await ensureSlots(db, name, dueSlots(minute, new Date(), 1));
      expect(await claimNextRun(db, "sched-crash", name, 100, 10)).not.toBeNull();
      await delay(200);
      await new Scheduler({ db, owner: "sched-ok", log, jobs: [job] }).tick(new Date());
      expect(ran).toHaveLength(1);
      const [row] = await db.scheduledRun.findMany({ where: { jobName: name } });
      expect(row).toMatchObject({ status: "completed", attempts: 2 });
    });
  });
});
