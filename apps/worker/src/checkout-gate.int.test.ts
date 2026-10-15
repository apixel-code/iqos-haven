import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createEmailConsumer } from "@ih/application";
import {
  assertTestDatabase,
  emailIntegrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  queueIntegrationTestEnvSchema,
} from "@ih/config";
import { checkoutAddressSchema, checkoutContactSchema } from "@ih/contracts";
import {
  createDatabase,
  createPool,
  createStoreOrder,
  findStrandedEffects,
  IdempotencyExpiredError,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner, startEffectWorkers } from "./effects";
import { SmtpEmailAdapter } from "./email";
import { createConfirmationCleanupJob, createIdempotencyCleanupJob } from "./idempotency";
import { createNotificationConsumer, newOrderEmailPlanner } from "./order-notifications";
import { BullEffectEnqueuer, createQueue, createQueueConnection, testQueuePrefix } from "./queue";
import { effectQueueName, type EffectJobData } from "./queues";
import { OutboxRelay, type EffectEnqueuer } from "./relay";

/**
 * Checkout correctness gate, worker side (roadmap step 82, M7): an order placed by the real
 * order transaction reaches the shop through the real relay, queue and consumers, and an
 * unavailable queue never costs an order. Real PostgreSQL, queue Redis and Mailpit. The order is
 * placed through `createStoreOrder` with the quote taken as accepted: quote acceptance and the
 * HTTP route are proven in the API tests, and the browser journey joins the two halves.
 */
loadLocalEnvFile();
const env = loadEnv(queueIntegrationTestEnvSchema);
const mail = loadEnv(emailIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-checkout-gate-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "checkout-gate-test", level: "silent" });
const redis = createQueueConnection(env.QUEUE_REDIS_URL);
const prefix = testQueuePrefix();
const smtp = new SmtpEmailAdapter({
  host: mail.SMTP_HOST,
  port: mail.SMTP_PORT,
  secure: false,
  from: "no-reply@iqoshaven.local",
});
const SHOP = `gate-${randomUUID().slice(0, 8)}@iqoshaven.test`;
const tag = () => "g" + randomUUID().replaceAll("-", "").slice(0, 16);
let ownerId = "";
let areaId = "";
let variantId = "";
let serial = 0;

/** An order placed the way the API places it: one transaction, event and effects included. */
async function placeOrder(
  quantity: number,
  idempotencyKey = randomBytes(24).toString("base64url"),
) {
  const input = {
    idempotencyKey,
    contact: checkoutContactSchema.parse({
      name: "Gate Buyer",
      phone: "050 630 " + String(++serial).padStart(4, "0"),
    }),
    address: checkoutAddressSchema.parse({
      areaId,
      type: "villa",
      building: "Gate Villa 7",
      notes: "Gate note",
    }),
    lines: [{ variantId, quantity }],
    couponCode: null,
    quote: { fingerprint: "A".repeat(43), accept: () => "ACCEPTED" as const },
    age: { policyVersion: "gate-policy" },
    requestId: randomUUID(),
  };
  const placed = await createStoreOrder(db, input);
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: placed.orderId!, eventType: "order.created" },
  });
  return { ...placed, orderId: placed.orderId!, eventId: event.id, input };
}
const runner = () =>
  new EffectRunner({
    db,
    owner: "gate-" + randomUUID().slice(0, 6),
    log,
    handlers: [
      createNotificationConsumer({ log }),
      createEmailConsumer({
        adapter: smtp,
        from: "no-reply@iqoshaven.local",
        planners: { "order.created": newOrderEmailPlanner(db) },
      }),
    ],
  });
/** True once neither consumer queue has a job waiting, running or delayed. */
async function drained() {
  const queues = (["notification", "email"] as const).map((consumer) =>
    createQueue(effectQueueName(consumer), redis, prefix),
  );
  try {
    for (let i = 0; i < 100; i++) {
      const counts = await Promise.all(
        queues.map((queue) => queue.getJobCounts("wait", "active", "delayed")),
      );
      if (counts.every((c) => (c.wait ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) === 0))
        return true;
      await delay(50);
    }
    return false;
  } finally {
    await Promise.all(queues.map((queue) => queue.close()));
  }
}
async function completed(eventId: string) {
  for (let i = 0; i < 150; i++) {
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (row.completedAt) return true;
    await delay(100);
  }
  return false;
}
async function mailFor(orderNumber: string) {
  const listing = await fetch(
    `${mail.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`bcc:${SHOP} subject:"${orderNumber}"`)}`,
  );
  return ((await listing.json()) as { messages: Array<{ ID: string; Subject: string }> }).messages;
}

describe("checkout gate: a placed order and the worker (PostgreSQL, queue Redis, Mailpit)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "gate-owner@iqoshaven.test",
          name: "Gate Owner",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "gate_area",
          name: "Gate Area",
          emirate: "ajman",
          active: true,
          updatedBy: ownerId,
        },
      })
    ).id;
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: ownerId,
        value: { flatFeeFils: 1500, etaText: "Gate ETA", freeThresholdFils: null },
      },
    });
    await db.setting.create({
      data: {
        key: "notifications",
        updatedBy: ownerId,
        value: { inApp: true, newOrderEmail: { enabled: true, recipients: [SHOP] } },
      },
    });
    const brand = await db.brand.create({
      data: { name: "Gate brand", slug: tag(), active: true },
    });
    const category = await db.category.create({
      data: { name: "Gate category", slug: tag(), active: true },
    });
    const product = await db.product.create({
      data: {
        name: "Gate Kit",
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
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 50, 50, 'INITIAL_STOCK', $2)",
      [variantId, randomUUID()],
    );
  });
  afterAll(async () => {
    smtp.close();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("M7 gate: the order transaction, relay, queue and consumers tell the shop once", async () => {
    const order = await placeOrder(2);
    // The order is complete before any worker runs: stock taken, both effects only pending.
    expect(order.response).toMatchObject({ totalFils: 25500 });
    expect((await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand).toBe(48);
    const pending = await db.consumerEffect.findMany({ where: { eventId: order.eventId } });
    expect(pending.map((effect) => [effect.consumer, effect.status]).sort()).toEqual([
      ["email", "pending"],
      ["notification", "pending"],
    ]);

    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    const workers = startEffectWorkers(runner(), redis, 2, log, prefix);
    try {
      const relay = new OutboxRelay({ db, enqueuer, owner: "gate-relay", log });
      await relay.tick();
      expect(await completed(order.eventId)).toBe(true);
      // A second relay pass and a duplicate delivery of both jobs change nothing.
      await relay.tick();
      for (const effect of pending)
        await enqueuer.enqueue(
          {
            eventId: order.eventId,
            effectId: effect.id,
            consumer: effect.consumer,
          } as EffectJobData,
          `dup-${effect.id}`,
          0,
        );
      // Wait until the workers have taken every duplicate, so the checks below are about
      // duplicates that really ran.
      expect(await drained()).toBe(true);
    } finally {
      await workers.stop();
      await enqueuer.close();
    }
    const effects = await db.consumerEffect.findMany({ where: { eventId: order.eventId } });
    expect(effects.every((effect) => effect.status === "completed" && effect.attempts === 1)).toBe(
      true,
    );
    // Inbox: one notification, a receipt for the Owner, AED 255.00 = 2 × 120.00 + 15.00.
    const notifications = await db.notification.findMany({
      where: { sourceEventId: order.eventId },
      include: { receipts: true },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: `New order ${order.response.orderNumber}`,
      body: "2 items · AED 255.00 · Gate Area",
    });
    expect(notifications[0]!.receipts.map((receipt) => receipt.userId)).toEqual([ownerId]);
    // Email: exactly one message in Mailpit, with nothing about the customer in it.
    const messages = await mailFor(order.response.orderNumber);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.Subject).toBe(`New order ${order.response.orderNumber} (AED 255.00)`);
    const message = (await (
      await fetch(`${mail.MAILPIT_URL}/api/v1/message/${messages[0]!.ID}`)
    ).json()) as { Subject: string; Text: string; HTML: string; To: unknown; Bcc: unknown };
    // What a reader sees, not the random message IDs (a hex ID can contain "630" by chance).
    const body = JSON.stringify([
      message.Subject,
      message.Text,
      message.HTML,
      message.To,
      message.Bcc,
    ]);
    for (const personal of ["Gate Buyer", "630", "Gate Villa", "Gate note"])
      expect(body).not.toContain(personal);
    expect(await findStrandedEffects(db, 1, 100)).toEqual([]);
  });

  it("an unavailable queue costs no order: the work waits in PostgreSQL and is done later", async () => {
    const down: EffectEnqueuer = {
      enqueue: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    // The order is placed while nothing can be queued.
    const order = await placeOrder(1);
    await new OutboxRelay({ db, enqueuer: down, owner: "gate-down", log }).tick();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(
      "pending",
    );
    expect(await db.notification.count({ where: { sourceEventId: order.eventId } })).toBe(0);
    const waiting = await db.outboxEvent.findUniqueOrThrow({ where: { id: order.eventId } });
    expect(waiting.completedAt).toBeNull();
    // Neither effect ran or was lost: both are still to do.
    const during = await db.consumerEffect.findMany({ where: { eventId: order.eventId } });
    expect(during).toHaveLength(2);
    expect(during.every((effect) => effect.status !== "completed" && effect.attempts === 0)).toBe(
      true,
    );
    // The queue comes back: the same event is dispatched and both effects complete.
    await pool.query(
      "UPDATE outbox_events SET lease_expires_at = now() - interval '1 minute' WHERE id=$1",
      [order.eventId],
    );
    const enqueuer = new BullEffectEnqueuer(redis, prefix);
    const workers = startEffectWorkers(runner(), redis, 2, log, prefix);
    try {
      await new OutboxRelay({ db, enqueuer, owner: "gate-up", log }).tick();
      expect(await completed(order.eventId)).toBe(true);
    } finally {
      await workers.stop();
      await enqueuer.close();
    }
    expect(await db.notification.count({ where: { sourceEventId: order.eventId } })).toBe(1);
    expect(await mailFor(order.response.orderNumber)).toHaveLength(1);
  });

  it("the cleanup jobs remove expired answers and replay material, and the key still never orders again", async () => {
    const order = await placeOrder(1);
    const records = () => db.idempotencyRecord.count({ where: { resourceId: order.orderId } });
    const jobs = [
      createIdempotencyCleanupJob({ db, log }),
      createConfirmationCleanupJob({ db, log }),
    ];
    // Nothing has expired: both jobs leave the answer alone, however often they run.
    for (const job of jobs) await job.run(new Date());
    expect(await records()).toBe(1);
    // Two days pass. The table refuses changes to an answer's dates, so the test moves them
    // with that guard off; what is shown is that the jobs remove what is past its expiry.
    await pool.query("ALTER TABLE idempotency_records DISABLE TRIGGER USER");
    try {
      await pool.query(
        "UPDATE idempotency_records SET created_at=created_at-interval '2 days', expires_at=expires_at-interval '2 days' WHERE resource_id=$1",
        [order.orderId],
      );
    } finally {
      await pool.query("ALTER TABLE idempotency_records ENABLE TRIGGER USER");
    }
    for (const job of jobs) await job.run(new Date());
    for (const job of jobs) await job.run(new Date());
    expect(await records()).toBe(0);
    // The same request with the same key is told the order exists; nothing new is written.
    const before = await db.order.count();
    const stock = (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand;
    await expect(createStoreOrder(db, order.input)).rejects.toBeInstanceOf(IdempotencyExpiredError);
    expect(await db.order.count()).toBe(before);
    expect((await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand).toBe(
      stock,
    );
  });
});
