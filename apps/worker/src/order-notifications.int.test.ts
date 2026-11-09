import { randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent } from "@ih/contracts";
import { formatOrderNumber } from "@ih/domain";
import {
  createDatabase,
  createPool,
  PrismaOutboxWriter,
  withTransaction,
  writeNewOrderNotification,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import {
  createNotificationConsumer,
  customerOrderEmailPlanner,
  newOrderEmailPlanner,
} from "./order-notifications";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-order-notifications-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "order-notifications-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const SHOP = "shop-inbox@iqoshaven.test";

let ownerId = "";
let staffId = "";
let inactiveId = "";
let noInboxId = "";
/** A committed order and its `order.created` event, written the way order creation writes it. */
async function placed(quantity = 1) {
  const seeded = await seedOrder(pool, { quantity });
  const eventId = await withTransaction(db, (tx) =>
    new PrismaOutboxWriter().publish(
      tx,
      defineEvent("order.created", seeded.orderId, { orderId: seeded.orderId }, 1),
    ),
  );
  const effects = await db.consumerEffect.findMany({ where: { eventId } });
  const job = (consumer: "notification" | "email") => ({
    eventId,
    effectId: effects.find((effect) => effect.consumer === consumer)!.id,
    consumer,
  });
  const order = await db.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
  return { ...seeded, eventId, effects, job, order };
}
const personal = (order: Awaited<ReturnType<typeof placed>>["order"]) => [
  order.customerName,
  order.customerPhoneE164,
  order.customerPhoneE164.slice(-8),
  order.addressBuilding,
];
const inbox = () =>
  new EffectRunner({
    db,
    owner: "inbox-test",
    log,
    handlers: [createNotificationConsumer({ log })],
  });
function mailer(send?: () => never) {
  const messages: EmailMessage[] = [];
  const runner = new EffectRunner({
    db,
    owner: "order-email-test",
    log,
    handlers: [
      createEmailConsumer({
        from: "no-reply@iqoshaven.local",
        planners: {
          "order.created": newOrderEmailPlanner(db),
          "order.confirmation_requested": customerOrderEmailPlanner(db),
        },
        adapter: {
          send: async (message) => {
            send?.();
            messages.push(message);
            return {
              receipt: "test:" + message.deliveryKey,
              accepted: message.bcc.length,
              rejected: 0,
            };
          },
        },
      }),
    ],
  });
  return { messages, runner };
}
const setNotifications = async (value: unknown) => {
  await pool.query("DELETE FROM settings WHERE key='notifications'");
  if (value)
    await db.setting.create({
      data: { key: "notifications", updatedBy: ownerId, value: value as object },
    });
};

describe("new-order notification and email (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = async (key: string) => (await db.role.findUniqueOrThrow({ where: { key } })).id;
    const user = async (name: string, roleId: string, active = true) =>
      (
        await db.staffUser.create({
          data: { email: `${name}@iqoshaven.test`, name, roleId, active, passwordHash: HASH },
        })
      ).id;
    ownerId = await user("inbox-owner", await role("owner"));
    staffId = await user("inbox-staff", await role("staff"));
    inactiveId = await user("inbox-inactive", await role("staff"), false);
    // A role that can read orders but has no inbox gets no receipt.
    const limited = await db.role.create({ data: { key: "no_inbox_test", name: "No inbox" } });
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key='orders.read'",
      [limited.id],
    );
    noInboxId = await user("inbox-none", limited.id);
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("requires the inbox, the email and the analytics for every new order event", async () => {
    const { effects } = await placed();
    expect(effects.map((effect) => effect.consumer).sort()).toEqual([
      "analytics_rollup",
      "email",
      "notification",
    ]);
  });

  it("writes one notification and one receipt per eligible user, once", async () => {
    await setNotifications(null);
    const data = await placed(3);
    const runner = inbox();
    expect(await runner.run(data.job("notification"))).toBe("completed");
    expect(await runner.run(data.job("notification"))).toBe("duplicate");
    const [notification, ...rest] = await db.notification.findMany({
      where: { sourceEventId: data.eventId },
      include: { receipts: true },
    });
    expect(rest).toEqual([]);
    // 3 × AED 50.00 + AED 15.00 delivery.
    expect(notification).toMatchObject({
      type: "order.new",
      title: `New order IH-${String(data.orderNumber).padStart(6, "0")}`,
      body: `3 items · AED 165.00 · ${data.order.areaName}`,
      link: `/orders/${data.orderId}`,
    });
    for (const text of personal(data.order))
      expect(notification!.title + notification!.body + notification!.link).not.toContain(text);
    const users = notification!.receipts.map((receipt) => receipt.userId);
    expect(users).toContain(ownerId);
    expect(users).toContain(staffId);
    expect(users).not.toContain(inactiveId);
    expect(users).not.toContain(noInboxId);
    expect(new Set(users).size).toBe(users.length);
    expect(notification!.receipts.every((receipt) => receipt.readAt === null)).toBe(true);
  });

  it("keeps each user's read state through a redelivery, and the content as first written", async () => {
    const data = await placed();
    const write = () =>
      withTransaction(db, (tx) =>
        writeNewOrderNotification(tx, { eventId: data.eventId, orderId: data.orderId }),
      );
    const first = await write();
    if (first.outcome !== "written") throw new Error("expected a notification");
    expect(first.created).toBe(true);
    expect(first.receipts).toBeGreaterThanOrEqual(2);
    const id = first.notificationId;
    await db.notificationReceipt.update({
      where: { notificationId_userId: { notificationId: id, userId: staffId } },
      data: { readAt: new Date(Date.now() + 1000) },
    });
    // A user who becomes eligible later is added by a redelivery; nobody is told twice.
    await db.staffUser.update({ where: { id: inactiveId }, data: { active: true } });
    expect(await write()).toMatchObject({ created: false, notificationId: id, receipts: 1 });
    await db.staffUser.update({ where: { id: inactiveId }, data: { active: false } });
    expect(await write()).toMatchObject({ created: false, receipts: 0 });
    const receipt = (userId: string) =>
      db.notificationReceipt.findUniqueOrThrow({
        where: { notificationId_userId: { notificationId: id, userId } },
      });
    expect((await receipt(staffId)).readAt).not.toBeNull();
    expect((await receipt(ownerId)).readAt).toBeNull();
    // The database refuses anything else.
    const refused = (sql: string, params: unknown[]) =>
      expect(pool.query(sql, params)).rejects.toThrow();
    await refused("UPDATE notifications SET title='Changed' WHERE id=$1", [id]);
    await refused("DELETE FROM notifications WHERE id=$1", [id]);
    await refused(
      "UPDATE notification_receipts SET read_at=NULL WHERE notification_id=$1 AND user_id=$2",
      [id, staffId],
    );
    await refused(
      "UPDATE notification_receipts SET user_id=$3 WHERE notification_id=$1 AND user_id=$2",
      [id, ownerId, noInboxId],
    );
    await refused("DELETE FROM notification_receipts WHERE notification_id=$1", [id]);
    await refused(
      "INSERT INTO notifications (source_event_id, type, title, body, link) VALUES ($1, 'order.new', 'T', 'B', 'https://elsewhere.example/x')",
      [randomUUID()],
    );
  });

  it("writes nothing when the inbox is switched off, and still completes", async () => {
    await setNotifications({ inApp: false, newOrderEmail: { enabled: false, recipients: [] } });
    const data = await placed();
    expect(await inbox().run(data.job("notification"))).toBe("completed");
    expect(await db.notification.count({ where: { sourceEventId: data.eventId } })).toBe(0);
    await setNotifications(null);
  });

  it("sends no email until the Owner switches it on, then one to the listed addresses", async () => {
    await setNotifications(null);
    const quiet = await placed();
    const unconfigured = mailer();
    expect(await unconfigured.runner.run(quiet.job("email"))).toBe("completed");
    expect(unconfigured.messages).toEqual([]);
    await setNotifications({ inApp: true, newOrderEmail: { enabled: false, recipients: [SHOP] } });
    const off = await placed();
    expect(await unconfigured.runner.run(off.job("email"))).toBe("completed");
    expect(unconfigured.messages).toEqual([]);
    expect(
      (await db.consumerEffect.findUniqueOrThrow({ where: { id: off.job("email").effectId } }))
        .externalReceipt,
    ).toBe("no-recipients");

    await setNotifications({
      inApp: true,
      newOrderEmail: { enabled: true, recipients: [SHOP, "second@iqoshaven.test"] },
    });
    const data = await placed(2);
    const { messages, runner } = mailer();
    expect(await runner.run(data.job("email"))).toBe("completed");
    expect(await runner.run(data.job("email"))).toBe("duplicate");
    expect(messages).toHaveLength(1);
    const [message] = messages;
    const number = formatOrderNumber(data.orderNumber);
    expect([...message!.bcc].sort()).toEqual(["second@iqoshaven.test", SHOP]);
    // 2 × AED 50.00 + AED 15.00 delivery.
    expect(message!.subject).toBe(`New order ${number} (AED 115.00)`);
    expect(message!.text).toContain("Items: 2 items");
    expect(message!.text).toContain("Area: " + data.order.areaName);
    // Who ordered and what (Marina 2026-11-03, ADR 0104), so the shop can call from the email.
    expect(message!.text).toContain("Name: " + data.order.customerName);
    expect(message!.text).toContain("Phone: " + data.order.customerPhoneE164);
    expect(message!.text).toContain("Email: Not given");
    expect(message!.text).toMatch(/\n- .+ × 2: AED 100\.00\n/);
    // Still not the address or anything that grants access.
    for (const text of [data.order.addressBuilding, data.orderId, "http"].filter(
      (text): text is string => Boolean(text),
    ))
      expect(message!.subject + message!.text + message!.html).not.toContain(text);
    await setNotifications(null);
  });

  it("sends the shopper one order confirmation to the email given at checkout (ADR 0102)", async () => {
    const data = await placed(2);
    await pool.query(
      "UPDATE orders SET customer_email='buyer@example.test', version=version+1 WHERE id=$1",
      [data.orderId],
    );
    const confirmation = async (orderId: string) => {
      const eventId = await withTransaction(db, (tx) =>
        new PrismaOutboxWriter().publish(
          tx,
          defineEvent("order.confirmation_requested", orderId, { orderId }, 1),
        ),
      );
      const [effect] = await db.consumerEffect.findMany({ where: { eventId } });
      expect(effect!.consumer).toBe("email");
      return { eventId, effectId: effect!.id, consumer: "email" as const };
    };
    const job = await confirmation(data.orderId);
    const { messages, runner } = mailer();
    expect(await runner.run(job)).toBe("completed");
    expect(await runner.run(job)).toBe("duplicate");
    expect(messages).toHaveLength(1);
    const [message] = messages;
    const number = formatOrderNumber(data.orderNumber);
    expect([...message!.bcc]).toEqual(["buyer@example.test"]);
    expect(message!.subject).toBe(`Order ${number} received (AED 115.00)`);
    expect(message!.text).toContain("Total: AED 115.00");
    // The order's own payment method, read from the database (ADR 0111).
    expect(message!.text).toContain("Payment: Cash on delivery");
    expect(message!.text).toContain("Pay in cash when your order arrives.");
    expect(message!.text).toContain("Delivery to " + data.order.areaName);
    // The details the shopper gave are repeated to them (ADR 0104); the address and IDs are not.
    expect(message!.text).toContain("Order number: " + number);
    expect(message!.text).toContain("Phone: " + data.order.customerPhoneE164);
    expect(message!.text).toContain("Email: buyer@example.test");
    for (const text of [data.order.addressBuilding, data.orderId].filter((text): text is string =>
      Boolean(text),
    ))
      expect(message!.subject + message!.text + message!.html).not.toContain(text);
    // An order without an email (older or staff-entered) completes without sending.
    const silent = await placed();
    const none = mailer();
    expect(await none.runner.run(await confirmation(silent.orderId))).toBe("completed");
    expect(none.messages).toEqual([]);
  });

  it("does not depend on email: a failing provider leaves the order and its inbox entry alone", async () => {
    await setNotifications({ inApp: true, newOrderEmail: { enabled: true, recipients: [SHOP] } });
    const data = await placed();
    const failing = mailer(() => {
      throw new Error("provider down");
    });
    expect(await failing.runner.run(data.job("email"))).toBe("retry");
    expect(await inbox().run(data.job("notification"))).toBe("completed");
    expect(await db.notification.count({ where: { sourceEventId: data.eventId } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: data.orderId } })).status).toBe(
      "pending",
    );
    const effect = await db.consumerEffect.findUniqueOrThrow({
      where: { id: data.job("email").effectId },
    });
    expect(effect.status).toBe("retry");
    expect(effect.lastError ?? "").not.toContain(SHOP);
    await setNotifications(null);
  });

  it("sends an event that is not a real order to investigation instead of retrying", async () => {
    const ghost = randomUUID();
    const eventId = await withTransaction(db, (tx) =>
      new PrismaOutboxWriter().publish(tx, defineEvent("order.created", ghost, { orderId: ghost })),
    );
    const effect = await db.consumerEffect.findFirstOrThrow({
      where: { eventId, consumer: "notification" },
    });
    expect(await inbox().run({ eventId, effectId: effect.id, consumer: "notification" })).toBe(
      "dead",
    );
    expect(
      (await db.consumerEffect.findUniqueOrThrow({ where: { id: effect.id } })).lastError,
    ).toBe("ORDER_NOT_FOUND");
    expect(await db.notification.count({ where: { sourceEventId: eventId } })).toBe(0);
  });
});
