import { randomBytes, randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import {
  checkoutAddressSchema,
  checkoutContactSchema,
  type OrderTransitionRequest,
} from "@ih/contracts";
import {
  createDatabase,
  createPool,
  createStoreOrder,
  listInbox,
  readAdminOrder,
  recordCollection,
  transitionOrder,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import { lowStockEmailPlanner } from "./low-stock-notifications";
import { createNotificationConsumer, newOrderEmailPlanner } from "./order-notifications";

/**
 * Operations gate (roadmap step 92, M8): a store order placed by the real order transaction
 * reaches staff through the inbox and email, a sale that crosses the alert level raises one
 * low-stock alert, and staff take the order from Pending to Delivered and then record the cash
 * as a separate command. Service level on real PostgreSQL: the HTTP routes, guards and the
 * queue path are proven in their own API and checkout-gate tests.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-operations-gate-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "operations-gate-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const SHOP = "operations@iqoshaven.test";
const tag = () => "o" + randomUUID().replaceAll("-", "").slice(0, 16);
let ownerId = "";
let staffId = "";
let areaId = "";
let variantId = "";
let serial = 0;
const messages: EmailMessage[] = [];

async function placeOrder(quantity: number) {
  const placed = await createStoreOrder(db, {
    idempotencyKey: randomBytes(24).toString("base64url"),
    contact: checkoutContactSchema.parse({
      name: "Operations Buyer",
      phone: "050 640 " + String(++serial).padStart(4, "0"),
    }),
    address: checkoutAddressSchema.parse({ areaId, type: "villa", building: "Ops Villa 3" }),
    lines: [{ variantId, quantity }],
    couponCode: null,
    quote: { fingerprint: "A".repeat(43), accept: () => "ACCEPTED" as const },
    age: { policyVersion: "ops-policy" },
    requestId: randomUUID(),
  });
  return placed.orderId!;
}
const runner = new EffectRunner({
  db,
  owner: "operations-gate",
  log,
  handlers: [
    createNotificationConsumer({ log }),
    createEmailConsumer({
      from: "no-reply@iqoshaven.local",
      planners: {
        "order.created": newOrderEmailPlanner(db),
        "inventory.low": lowStockEmailPlanner(db, log),
      },
      adapter: {
        send: async (message) => {
          messages.push(message);
          return { receipt: "ops:" + message.deliveryKey, accepted: 1, rejected: 0 };
        },
      },
    }),
  ],
});
/** Runs every unfinished effect once, as the relay and consumers would. */
async function work() {
  const effects = await db.consumerEffect.findMany({
    where: { completedAt: null },
    orderBy: { id: "asc" },
  });
  for (const effect of effects)
    expect(
      await runner.run({
        eventId: effect.eventId,
        effectId: effect.id,
        consumer: effect.consumer as "notification" | "email",
      }),
    ).toBe("completed");
}
const events = (eventType: string) => db.outboxEvent.count({ where: { eventType } });

describe("M8 operations gate: store order to collected cash (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const user = async (key: string) =>
      (
        await db.staffUser.create({
          data: {
            email: `ops-${key}@iqoshaven.test`,
            name: "Ops " + key,
            roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
            passwordHash: HASH,
          },
        })
      ).id;
    ownerId = await user("owner");
    staffId = await user("staff");
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "ops_area",
          name: "Ops Area",
          emirate: "sharjah",
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
          value: { flatFeeFils: 1500, etaText: "Ops ETA", freeThresholdFils: null },
        },
        {
          key: "notifications",
          updatedBy: ownerId,
          value: {
            inApp: true,
            newOrderEmail: { enabled: true, recipients: [SHOP] },
            lowStockEmail: true,
          },
        },
      ],
    });
    const brand = await db.brand.create({ data: { name: "Ops brand", slug: tag(), active: true } });
    const category = await db.category.create({
      data: { name: "Ops category", slug: tag(), active: true },
    });
    const product = await db.product.create({
      data: {
        name: "Ops Kit",
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
        data: {
          productId: product.id,
          sku: "OPS-KIT",
          active: true,
          isDefault: true,
          lowStockThreshold: 2,
        },
      })
    ).id;
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 5, 5, 'INITIAL_STOCK', $2)",
      [variantId, randomUUID()],
    );
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("tells staff about the order and the low stock once, then fulfils and collects", async () => {
    // 5 → 2 units: the sale crosses the alert level inside the order transaction.
    const orderId = await placeOrder(3);
    expect(await events("inventory.low")).toBe(1);
    await work();

    const inbox = await listInbox(db, staffId, { limit: 20 });
    expect(inbox.items.map((item) => item.type).sort()).toEqual(["inventory.low", "order.new"]);
    expect(inbox.items.find((item) => item.type === "inventory.low")).toMatchObject({
      title: "Low stock: Ops Kit",
      body: "OPS-KIT · 2 left (alert level 2)",
    });
    expect(messages.map((message) => message.subject).sort()).toEqual([
      expect.stringMatching(/^Low stock: Ops Kit \(OPS-KIT\)$/),
      expect.stringMatching(/^New order IH-\d{6} \(AED 375\.00\)$/),
    ]);
    // No customer detail leaves the order in either channel.
    for (const text of [
      ...inbox.items.flatMap((item) => [item.title, item.body]),
      ...messages.map((message) => message.text),
    ])
      expect(text).not.toMatch(/Operations Buyer|Ops Villa|0640/);

    // Staff fulfil the order one step at a time, each with its expected version.
    let version = (await readAdminOrder(db, staffId, orderId)).version;
    for (const to of ["confirmed", "processing", "out_for_delivery", "delivered"] as const) {
      const request: OrderTransitionRequest = {
        to,
        expectedVersion: version,
        commandId: randomUUID(),
      };
      const moved = await transitionOrder(
        db,
        { actorId: staffId, requestId: randomUUID() },
        orderId,
        request,
      );
      expect(moved.toStatus).toBe(to);
      version = moved.orderVersion;
    }
    // Delivered is not collected.
    const delivered = await readAdminOrder(db, staffId, orderId);
    expect(delivered).toMatchObject({ status: "delivered", codStatus: "pending" });

    const command = {
      expectedVersion: version,
      commandId: randomUUID(),
      amountFils: delivered.totalFils,
      reference: "Courier slip 17",
    };
    const context = { actorId: staffId, requestId: randomUUID() };
    const collected = await recordCollection(db, context, orderId, command);
    expect(collected).toMatchObject({ kind: "recorded", amountFils: 37500, replayed: false });
    expect((await recordCollection(db, context, orderId, command)).replayed).toBe(true);
    expect(await readAdminOrder(db, staffId, orderId)).toMatchObject({
      status: "delivered",
      codStatus: "collected",
    });

    // Selling more while already low raises no second alert.
    await placeOrder(1);
    expect(await events("inventory.low")).toBe(1);
    await work();
    expect(messages.filter((message) => message.subject.startsWith("Low stock"))).toHaveLength(1);
  });
});
