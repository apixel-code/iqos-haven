import { randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { adjustStock, createDatabase, createPool, LOW_STOCK_QUIET_HOURS } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import { lowStockEmailPlanner } from "./low-stock-notifications";
import { createNotificationConsumer } from "./order-notifications";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-low-stock-notifications-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "low-stock-notifications-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const SHOP = "stock-alerts@iqoshaven.test";

let ownerId = "";
let staffId = "";
let noInventoryId = "";
let brandId = "";
let categoryId = "";

/** A published product with one active variant at `stock`, alerting at `threshold`. */
async function variant(stock: number, threshold: number, status = "published") {
  const tag = randomUUID().slice(0, 8);
  const product = await db.product.create({
    data: {
      name: "Lune Air " + tag,
      slug: "lune-air-" + tag,
      brandId,
      categoryId,
      type: "kit",
      basePriceFils: 5000n,
      status,
    },
  });
  const row = await db.variant.create({
    data: {
      productId: product.id,
      sku: "LUNE-" + tag.toUpperCase(),
      active: true,
      isDefault: true,
      lowStockThreshold: threshold,
    },
  });
  if (stock > 0) await move(row.id, stock, "INITIAL_STOCK");
  return { ...row, productId: product.id };
}
const move = (
  variantId: string,
  delta: number,
  reason: "INITIAL_STOCK" | "RESTOCK" | "MANUAL" | "DAMAGE" = "MANUAL",
) =>
  adjustStock(db, { actorId: ownerId, requestId: randomUUID() }, variantId, {
    commandId: randomUUID(),
    reason,
    delta,
    note: "test",
  });
/** The `inventory.low` events of a variant, oldest first, with their effect jobs. */
async function lowEvents(variantId: string) {
  const events = await db.outboxEvent.findMany({
    where: { aggregateId: variantId, eventType: "inventory.low" },
    orderBy: { id: "asc" },
    include: { effects: true },
  });
  return events.map((event) => ({
    eventId: event.id,
    consumers: event.effects.map((effect) => effect.consumer).sort(),
    job: (consumer: "notification" | "email") => ({
      eventId: event.id,
      effectId: event.effects.find((effect) => effect.consumer === consumer)!.id,
      consumer,
    }),
  }));
}
const inbox = new EffectRunner({
  db,
  owner: "low-stock-inbox-test",
  log,
  handlers: [createNotificationConsumer({ log })],
});
function mailer() {
  const messages: EmailMessage[] = [];
  const runner = new EffectRunner({
    db,
    owner: "low-stock-email-test",
    log,
    handlers: [
      createEmailConsumer({
        from: "no-reply@iqoshaven.local",
        planners: { "inventory.low": lowStockEmailPlanner(db, log) },
        adapter: {
          send: async (message) => {
            messages.push(message);
            return { receipt: "test:" + message.deliveryKey, accepted: 1, rejected: 0 };
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
const notificationsOf = (eventId: string) =>
  db.notification.findMany({ where: { sourceEventId: eventId }, include: { receipts: true } });

describe("low-stock notification and email (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = async (key: string) => (await db.role.findUniqueOrThrow({ where: { key } })).id;
    const user = async (name: string, roleId: string) =>
      (
        await db.staffUser.create({
          data: { email: `${name}@iqoshaven.test`, name, roleId, active: true, passwordHash: HASH },
        })
      ).id;
    ownerId = await user("stock-owner", await role("owner"));
    staffId = await user("stock-staff", await role("staff"));
    // An inbox without the right to see stock gets no low-stock receipt.
    const limited = await db.role.create({ data: { key: "no_inventory_test", name: "Orders" } });
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('notifications.read_own','orders.read')",
      [limited.id],
    );
    noInventoryId = await user("stock-none", limited.id);
    brandId = (await db.brand.create({ data: { name: "Stock brand", slug: "stock-brand" } })).id;
    categoryId = (
      await db.category.create({ data: { name: "Stock category", slug: "stock-category" } })
    ).id;
  });
  beforeEach(async () => {
    await setNotifications({
      inApp: true,
      newOrderEmail: { enabled: false, recipients: [SHOP] },
      lowStockEmail: true,
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("alerts the inbox and the email once per crossing, not for every sale while low", async () => {
    const row = await variant(12, 10);
    await move(row.id, -2); // 10: crossed
    await move(row.id, -3); // 7: already low
    await move(row.id, -7); // 0: still low, no new alert
    const events = await lowEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.consumers).toEqual(["email", "notification"]);

    expect(await inbox.run(events[0]!.job("notification"))).toBe("completed");
    expect(await inbox.run(events[0]!.job("notification"))).toBe("duplicate");
    const [notification, ...rest] = await notificationsOf(events[0]!.eventId);
    expect(rest).toEqual([]);
    // Current stock when delivered, not the level at the crossing.
    expect(notification).toMatchObject({
      type: "inventory.low",
      title: expect.stringMatching(/^Low stock: Lune Air /),
      body: `${row.sku} · Out of stock (alert level 10)`,
      link: `/inventory/${row.id}`,
    });
    const users = notification!.receipts.map((receipt) => receipt.userId);
    expect(users).toEqual(expect.arrayContaining([ownerId, staffId]));
    expect(users).not.toContain(noInventoryId);

    const { messages, runner } = mailer();
    expect(await runner.run(events[0]!.job("email"))).toBe("completed");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      bcc: [SHOP],
      subject: `Low stock: ${notification!.title.slice("Low stock: ".length)} (${row.sku})`,
    });
    expect(messages[0]!.text).toContain("Stock: Out of stock");
    expect(messages[0]!.text).not.toMatch(/https?:/);
  });

  it("keeps a bouncing variant quiet inside the window, and alerts again after it", async () => {
    const row = await variant(5, 3);
    const { messages, runner } = mailer();
    const deliver = async () => {
      const events = await lowEvents(row.id);
      const latest = events.at(-1)!;
      expect(await inbox.run(latest.job("notification"))).toBe("completed");
      expect(await runner.run(latest.job("email"))).toBe("completed");
      return latest.eventId;
    };
    await move(row.id, -2); // 3: crossed
    const first = await deliver();
    await move(row.id, 2); // 5: re-armed
    await move(row.id, -3); // 2: crossed again
    const second = await deliver();
    expect(await lowEvents(row.id)).toHaveLength(2);
    expect(await notificationsOf(first)).toHaveLength(1);
    // The second crossing is a new event, but nobody is told twice within the window.
    expect(await notificationsOf(second)).toEqual([]);
    expect(messages).toHaveLength(1);

    // After the window the next crossing alerts again.
    await pool.query(
      `UPDATE low_stock_alerts SET alerted_at = alerted_at - make_interval(hours => $2)
       WHERE variant_id=$1`,
      [row.id, LOW_STOCK_QUIET_HOURS],
    );
    await move(row.id, 4); // 6
    await move(row.id, -4); // 2
    const third = await deliver();
    expect(await notificationsOf(third)).toHaveLength(1);
    expect(messages).toHaveLength(2);
  });

  it("lets two crossings handled at once alert only once", async () => {
    const row = await variant(5, 3);
    await move(row.id, -2);
    await move(row.id, 2);
    await move(row.id, -2);
    const events = await lowEvents(row.id);
    expect(events).toHaveLength(2);
    const results = await Promise.all(events.map((event) => inbox.run(event.job("notification"))));
    expect(results).toEqual(["completed", "completed"]);
    const written = await db.notification.count({
      where: { sourceEventId: { in: events.map((event) => event.eventId) } },
    });
    expect(written).toBe(1);
  });

  it("sends nothing for a variant that is no longer low, not on sale, or switched off", async () => {
    const { messages, runner } = mailer();
    const deliverAll = async (variantId: string) => {
      for (const event of await lowEvents(variantId)) {
        expect(await inbox.run(event.job("notification"))).toBe("completed");
        expect(await runner.run(event.job("email"))).toBe("completed");
        expect(await notificationsOf(event.eventId)).toEqual([]);
      }
    };
    // Restocked before the worker got to it.
    const restocked = await variant(4, 3);
    await move(restocked.id, -1);
    await move(restocked.id, 5, "RESTOCK");
    await deliverAll(restocked.id);
    // A draft product's variant.
    const draft = await variant(4, 3, "draft");
    await move(draft.id, -2);
    await deliverAll(draft.id);
    // Email and inbox switched off.
    await setNotifications({
      inApp: false,
      newOrderEmail: { enabled: true, recipients: [SHOP] },
      lowStockEmail: false,
    });
    const off = await variant(4, 3);
    await move(off.id, -2);
    await deliverAll(off.id);
    expect(messages).toEqual([]);
    // Switching off claims nothing: the inbox can still alert later for the same variant.
    expect(
      (await pool.query("SELECT 1 FROM low_stock_alerts WHERE variant_id=$1", [off.id])).rowCount,
    ).toBe(0);
  });

  it("refuses an event for a missing variant as a fault, not a retry", async () => {
    const eventId = randomUUID();
    const variantId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (id, event_type, schema_version, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'inventory.low', 1, 'variant', $2, $3)`,
      [eventId, variantId, JSON.stringify({ variantId, cause: "stock" })],
    );
    const effect = await db.consumerEffect.create({
      data: { eventId, consumer: "notification" },
    });
    expect(await inbox.run({ eventId, effectId: effect.id, consumer: "notification" })).toBe(
      "dead",
    );
  });
});
