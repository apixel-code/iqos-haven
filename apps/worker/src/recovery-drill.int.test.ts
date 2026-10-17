import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEmailConsumer,
  PermanentEffectError,
  type EmailAdapter,
  type EmailMessage,
} from "@ih/application";
import {
  assertTestDatabase,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { checkoutAddressSchema, checkoutContactSchema, effectJobId } from "@ih/contracts";
import {
  createDatabase,
  createPool,
  createStoreOrder,
  findStrandedEffects,
  replayDeadEffect,
  stockReconciliationMismatches,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { dubaiDate } from "@ih/domain";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnalyticsRollupConsumer } from "./analytics-rollup";
import { EffectRunner, startEffectWorkers } from "./effects";
import { createNotificationConsumer, newOrderEmailPlanner } from "./order-notifications";
import { BullEffectEnqueuer, createQueue, createQueueConnection, testQueuePrefix } from "./queue";
import { effectQueueName } from "./queues";
import { EffectReconciler } from "./reconciler";
import { OutboxRelay, type EffectEnqueuer } from "./relay";

/**
 * Worker crash and Redis-loss recovery drill (roadmap step 117). A real `order.created` event
 * (inbox, email, analytics) goes through the real relay, queue, reconciler and runners while
 * failures are injected: a crash before enqueue, Redis losing every job, a crash after the
 * email provider accepted, a lease lost mid-send, a permanent failure replayed by the Owner,
 * and duplicate deliveries afterwards. The shop must hear about each order exactly once.
 *
 * The email provider is a stub that, like Resend, accepts a message once per idempotency key
 * (`deliveryKey`); it counts what it was asked and what it delivered.
 */
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-recovery-drill",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "recovery-drill", level: "silent" });
const redis = createQueueConnection(env.QUEUE_REDIS_URL);
const prefix = testQueuePrefix();
const SHOP = "drill-shop@iqoshaven.test";
const tag = () => "d" + randomUUID().replaceAll("-", "").slice(0, 16);
let ownerId = "";
let areaId = "";
let variantId = "";
let serial = 0;

/** The provider: what it was asked to send and what it actually delivered (one per key). */
const provider = {
  asked: [] as EmailMessage[],
  delivered: new Map<string, EmailMessage>(),
  /** What the next send does. */
  next: "ok" as "ok" | "crash_after_accept" | "permanent" | "hang",
  reset() {
    this.asked = [];
    this.delivered.clear();
    this.next = "ok";
  },
};
const adapter: EmailAdapter = {
  async send(message, signal) {
    const mode = provider.next;
    provider.next = "ok";
    provider.asked.push(message);
    if (mode === "permanent") throw new PermanentEffectError("RECIPIENT_REJECTED");
    if (mode === "hang") {
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    if (!provider.delivered.has(message.deliveryKey))
      provider.delivered.set(message.deliveryKey, message);
    // Accepted by the provider, then the worker dies before recording it.
    if (mode === "crash_after_accept") throw new Error("worker crashed after provider accepted");
    return { receipt: "stub:" + message.deliveryKey, accepted: 1, rejected: 0 };
  },
  close() {},
} as EmailAdapter;
const handlers = () => [
  createNotificationConsumer({ log }),
  createAnalyticsRollupConsumer({ log }),
  createEmailConsumer({
    adapter,
    from: "no-reply@iqoshaven.local",
    planners: { "order.created": newOrderEmailPlanner(db) },
  }),
];
const runner = (owner = "drill-" + randomUUID().slice(0, 6), leaseMs?: number) =>
  new EffectRunner({ db, owner, log, handlers: handlers(), ...(leaseMs ? { leaseMs } : {}) });

async function placeOrder() {
  const placed = await createStoreOrder(db, {
    idempotencyKey: randomBytes(24).toString("base64url"),
    contact: checkoutContactSchema.parse({
      name: "Drill Buyer",
      phone: "050 640 " + String(++serial).padStart(4, "0"),
    }),
    address: checkoutAddressSchema.parse({ areaId, type: "villa", building: "Drill Villa" }),
    lines: [{ variantId, quantity: 1 }],
    couponCode: null,
    quote: { fingerprint: "A".repeat(43), accept: () => "ACCEPTED" as const },
    age: { policyVersion: "drill-policy" },
    requestId: randomUUID(),
  });
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: placed.orderId!, eventType: "order.created" },
    include: { effects: true },
  });
  const job = (consumer: "notification" | "email" | "analytics_rollup") => ({
    eventId: event.id,
    effectId: event.effects.find((effect) => effect.consumer === consumer)!.id,
    consumer,
  });
  return { orderId: placed.orderId!, eventId: event.id, job };
}
/** What the shop got for an order: inbox notifications, receipts, emails delivered. */
async function told(orderId: string, eventId: string) {
  const notifications = await db.notification.findMany({
    where: { sourceEventId: eventId },
    include: { receipts: true },
  });
  const number = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).orderNumber;
  const mails = [...provider.delivered.values()].filter((message) =>
    message.subject.includes(String(number).padStart(6, "0")),
  );
  return {
    notifications: notifications.length,
    receipts: notifications.flatMap((row) => row.receipts).length,
    emails: mails.length,
  };
}
async function eventDone(eventId: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if ((await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).completedAt)
      return true;
    await delay(100);
  }
  return false;
}
const effectsOf = (eventId: string) =>
  db.consumerEffect.findMany({ where: { eventId }, orderBy: { consumer: "asc" } });

describe("recovery drill: crashes and Redis loss around a real order (PostgreSQL + queue Redis)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "drill-owner@iqoshaven.test",
          name: "Drill Owner",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "drill_area",
          name: "Drill Area",
          emirate: "dubai",
          active: true,
          updatedBy: ownerId,
        },
      })
    ).id;
    await db.setting.createMany({
      data: [
        {
          key: "delivery",
          updatedBy: ownerId,
          value: { flatFeeFils: 1500, etaText: "Drill ETA", freeThresholdFils: null },
        },
        {
          key: "notifications",
          updatedBy: ownerId,
          value: { inApp: true, newOrderEmail: { enabled: true, recipients: [SHOP] } },
        },
      ],
    });
    const brand = await db.brand.create({
      data: { name: "Drill brand", slug: tag(), active: true },
    });
    const category = await db.category.create({
      data: { name: "Drill category", slug: tag(), active: true },
    });
    const product = await db.product.create({
      data: {
        name: "Drill Kit",
        slug: tag(),
        brandId: brand.id,
        categoryId: category.id,
        type: "kit",
        basePriceFils: 12000n,
        status: "published",
      },
    });
    variantId = (
      await db.variant.create({
        data: { productId: product.id, sku: tag().toUpperCase(), active: true, isDefault: true },
      })
    ).id;
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 100, 100, 'INITIAL_STOCK', $2)",
      [variantId, randomUUID()],
    );
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("a relay that dies before enqueuing loses nothing; Redis losing every job loses nothing", async () => {
    provider.reset();
    const { orderId, eventId } = await placeOrder();
    // 1. The relay claims the event, then dies before anything reaches Redis.
    const dying: EffectEnqueuer = {
      async enqueue() {
        throw new Error("process killed before enqueue");
      },
    };
    await new OutboxRelay({ db, enqueuer: dying, owner: "relay-dead", log }).tick();
    expect(
      (await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).dispatchedAt,
    ).toBeNull();
    // Its lease runs out; a healthy relay takes the event over.
    await pool.query(
      "UPDATE outbox_events SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [eventId],
    );
    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    try {
      await new OutboxRelay({ db, enqueuer, owner: "relay-live", log }).tick();
      expect((await effectsOf(eventId)).every((effect) => effect.status === "queued")).toBe(true);
      // 2. Redis loses every queued job before any worker runs.
      for (const consumer of ["notification", "email", "analytics_rollup"] as const)
        await createQueue(effectQueueName(consumer), redis, prefix).obliterate({ force: true });
      // 3. After the stale window the reconciler finds them in PostgreSQL and enqueues again.
      await pool.query(
        "UPDATE consumer_effects SET queued_at = now() - interval '10 minutes' WHERE event_id = $1",
        [eventId],
      );
      expect((await new EffectReconciler({ db, enqueuer, log }).tick()).requeued).toBe(3);
      // 4. The original job IDs arrive too (a late copy from before the loss).
      for (const effect of await effectsOf(eventId))
        await enqueuer.enqueue(
          { eventId, effectId: effect.id, consumer: effect.consumer as never },
          effectJobId(eventId, effect.consumer as never),
          0,
        );
      const workers = startEffectWorkers(runner(), redis, 3, log, prefix);
      try {
        expect(await eventDone(eventId)).toBe(true);
        await delay(500);
      } finally {
        await workers.stop();
      }
    } finally {
      await enqueuer.close();
    }
    expect(await told(orderId, eventId)).toMatchObject({ notifications: 1, emails: 1 });
    expect(
      (await effectsOf(eventId)).map((effect) => [effect.consumer, effect.status, effect.attempts]),
    ).toEqual([
      ["analytics_rollup", "completed", 1],
      ["email", "completed", 1],
      ["notification", "completed", 1],
    ]);
    // The day's figures count the order once.
    const day = await db.salesDaily.findUniqueOrThrow({
      where: { day: new Date(dubaiDate(new Date())) },
    });
    expect(day.placedOrders).toBe(await db.order.count());
    expect(await findStrandedEffects(db, 1, 100)).toEqual([]);
  });

  it("a crash after the provider accepted retries with the same key: one email delivered", async () => {
    provider.reset();
    const { orderId, eventId, job } = await placeOrder();
    provider.next = "crash_after_accept";
    expect(await runner().run(job("email"))).toBe("retry");
    await pool.query("UPDATE consumer_effects SET due_at = now() WHERE id = $1", [
      job("email").effectId,
    ]);
    expect(await runner().run(job("email"))).toBe("completed");
    expect(provider.asked).toHaveLength(2);
    // Both attempts used one idempotency key, so the provider delivered once.
    expect(new Set(provider.asked.map((message) => message.deliveryKey)).size).toBe(1);
    expect((await told(orderId, eventId)).emails).toBe(1);
  });

  it("a lease lost mid-send: the stale worker cannot finish, the new one sends once", async () => {
    provider.reset();
    const { orderId, eventId, job } = await placeOrder();
    provider.next = "hang";
    const stale = runner("drill-stale", 1500).run(job("email"));
    await delay(300);
    // The stale worker stops heartbeating (paused, partitioned); its lease is taken over.
    await pool.query("UPDATE consumer_effects SET lease_owner = 'drill-other' WHERE id = $1", [
      job("email").effectId,
    ]);
    expect(await stale).toBe("lease_lost");
    // The worker that took it over dies too: its lease runs out, and a new worker reclaims it.
    await pool.query(
      "UPDATE consumer_effects SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [job("email").effectId],
    );
    expect(await runner().run(job("email"))).toBe("completed");
    expect((await told(orderId, eventId)).emails).toBe(1);
  });

  it("a permanent failure goes dead, and the Owner's audited replay completes it once", async () => {
    provider.reset();
    const { orderId, eventId, job } = await placeOrder();
    provider.next = "permanent";
    expect(await runner().run(job("email"))).toBe("dead");
    const dead = await db.consumerEffect.findUniqueOrThrow({
      where: { id: job("email").effectId },
    });
    expect(dead).toMatchObject({ status: "dead", lastError: "RECIPIENT_REJECTED" });
    // The event is not complete while one of its effects is dead.
    for (const consumer of ["notification", "analytics_rollup"] as const)
      expect(await runner().run(job(consumer))).toBe("completed");
    expect(
      (await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).completedAt,
    ).toBeNull();
    // The cause is fixed; the Owner replays it.
    await replayDeadEffect(
      db,
      { requestId: randomUUID(), actorId: ownerId },
      job("email").effectId,
      "recipient fixed",
    );
    expect(
      await db.auditLog.count({
        where: { entityId: job("email").effectId, action: "effect.replayed" },
      }),
    ).toBe(1);
    expect(await runner().run(job("email"))).toBe("completed");
    expect(await eventDone(eventId, 20)).toBe(true);
    expect((await told(orderId, eventId)).emails).toBe(1);
  });

  it("after all that, duplicate deliveries of every effect change nothing", async () => {
    provider.reset();
    const { orderId, eventId, job } = await placeOrder();
    const jobs = (["notification", "email", "analytics_rollup"] as const).map(job);
    // Three copies of each job, on three workers at once.
    const outcomes = await Promise.all(
      jobs.flatMap((one) => [runner().run(one), runner().run(one), runner().run(one)]),
    );
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(3);
    expect(outcomes.every((outcome) => outcome === "completed" || outcome === "duplicate")).toBe(
      true,
    );
    const after = await told(orderId, eventId);
    expect(after).toMatchObject({ notifications: 1, emails: 1 });
    expect(provider.asked).toHaveLength(1);
    // And once more, later.
    for (const one of jobs) expect(await runner().run(one)).toBe("duplicate");
    expect(await told(orderId, eventId)).toEqual(after);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await findStrandedEffects(db, 1, 100)).toEqual([]);
  });
});
