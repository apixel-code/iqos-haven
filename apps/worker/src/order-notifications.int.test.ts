import { randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent } from "@ih/contracts";
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
import { createNotificationConsumer, newOrderEmailPlanner } from "./order-notifications";

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
        planners: { "order.created": newOrderEmailPlanner(db) },
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
    const number = `IH-${String(data.orderNumber).padStart(6, "0")}`;
    expect([...message!.bcc].sort()).toEqual(["second@iqoshaven.test", SHOP]);
    // 2 × AED 50.00 + AED 15.00 delivery.
    expect(message!.subject).toBe(`New order ${number} (AED 115.00)`);
    expect(message!.text).toContain("Items: 2 items");
    expect(message!.text).toContain("Area: " + data.order.areaName);
    for (const text of [...personal(data.order), data.orderId, "http"])
      expect(message!.subject + message!.text + message!.html).not.toContain(text);
    await setNotifications(null);
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
