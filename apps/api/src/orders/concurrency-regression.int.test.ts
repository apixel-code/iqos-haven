import "reflect-metadata";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import { checkoutAddressSchema, checkoutContactSchema } from "@ih/contracts";
import {
  adjustStock,
  cancelOrder,
  CatalogueConflictError,
  correctCollection,
  CouponRejectedError,
  couponCountMismatches,
  createDatabase,
  createPool,
  editOrder,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  InsufficientStockError,
  OrderCancelConflictError,
  OrderCollectionConflictError,
  OrderEditConflictError,
  OrderTransitionConflictError,
  QuoteNotAcceptedError,
  recordCollection,
  setStock,
  stockReconciliationMismatches,
  TransactionContentionError,
  transitionOrder,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { ageTicketPublicKey, ageTicketSigner } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CartQuoteService } from "../store/cart-quote.service";
import { CreateOrderService } from "./create-order.service";

/**
 * Commerce concurrency regression (roadmap step 116). Each command has its own race tests in
 * its step; this suite runs *different* commands against the same variant, order or coupon at
 * the same moment, then checks the whole database: ledger equals balance, no negative stock,
 * coupon counters equal live redemptions, one cancellation and one release per order, one
 * collection per command. Every refusal must be a known business answer; anything else (a
 * would-be 500) fails the test.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-concurrency-regression",
  searchPath: namespace,
  max: 20,
});
const db = createDatabase(pool, { schema: namespace });
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
  AGE_POLICY_VERSION: "concurrency-1",
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
  STOREFRONT_ORIGINS: "http://localhost:8080",
});

let app: INestApplication;
let quotes: CartQuoteService;
let orders: CreateOrderService;
let ownerId = "";
let areaId = "";
let serial = 0;
const key = () => "c" + randomUUID().replaceAll("-", "").slice(0, 16);
const as = () => ({ requestId: randomUUID(), actorId: ownerId });
const version = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).version;
const stockOf = async (id: string) =>
  (await db.variant.findUniqueOrThrow({ where: { id } })).stockOnHand;

/** Business refusals a racing command may legitimately get; anything else is a defect. */
const KNOWN = [
  CatalogueConflictError,
  CouponRejectedError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  InsufficientStockError,
  OrderCancelConflictError,
  OrderCollectionConflictError,
  OrderEditConflictError,
  OrderTransitionConflictError,
  QuoteNotAcceptedError,
  TransactionContentionError,
];
async function race<T>(work: Array<() => Promise<T>>) {
  const settled = await Promise.allSettled(work.map((run) => run()));
  const unexpected = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown)
    .filter((reason) => !KNOWN.some((kind) => reason instanceof kind));
  expect(
    unexpected.map((reason) => String(reason)),
    "only business refusals",
  ).toEqual([]);
  return {
    won: settled.filter((result) => result.status === "fulfilled").length,
    results: settled,
  };
}

async function variant(stock: number, priceFils = 5000n) {
  const brand = await db.brand.create({
    data: { name: "Race " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Race " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: "Race kit",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils: priceFils,
      status: "published",
    },
  });
  const row = await db.variant.create({
    data: { productId: product.id, sku: key().toUpperCase(), active: true, isDefault: true },
  });
  if (stock)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [row.id, stock, randomUUID()],
    );
  return row.id;
}

/** A complete checkout command for these lines, quoted now. */
async function checkout(
  lines: Array<{ variantId: string; quantity: number }>,
  couponCode: string | null = null,
  idempotencyKey = randomBytes(24).toString("base64url"),
) {
  const shown = await quotes.quote({ lines, areaId, couponCode });
  return {
    idempotencyKey,
    contact: checkoutContactSchema.parse({
      name: "Race Buyer",
      phone: "050 620 " + String(++serial).padStart(4, "0"),
    }),
    address: checkoutAddressSchema.parse({ areaId, type: "villa", building: "Race Villa 1" }),
    lines,
    couponCode,
    quoteToken: shown.quote.token,
    requestId: randomUUID(),
  } as Parameters<CreateOrderService["place"]>[0];
}
async function placed(
  lines: Array<{ variantId: string; quantity: number }>,
  code: string | null = null,
) {
  const result = await orders.place(await checkout(lines, code));
  return result.orderId!;
}

describe("commerce concurrency regression (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "race-owner@iqoshaven.test",
          name: "Race Owner",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "race_area",
          name: "Race Area",
          emirate: "dubai",
          active: true,
          updatedBy: ownerId,
        },
      })
    ).id;
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: ownerId,
        value: { flatFeeFils: 1500, etaText: "Race ETA", freeThresholdFils: null },
      },
    });
    app = await createApp(env, { pool, database: db });
    await app.init();
    quotes = app.get(CartQuoteService);
    orders = app.get(CreateOrderService);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("last units: checkouts, a damage write-off and a count all at once never oversell", async () => {
    const id = await variant(3);
    const commands = await Promise.all(
      Array.from({ length: 6 }, () => checkout([{ variantId: id, quantity: 1 }])),
    );
    const { results } = await race<unknown>([
      ...commands.map((command) => () => orders.place(command)),
      () =>
        adjustStock(db, as(), id, {
          commandId: randomUUID(),
          reason: "DAMAGE",
          delta: -1,
          note: "Dropped",
        }),
      () =>
        setStock(db, as(), id, {
          commandId: randomUUID(),
          expectedStockOnHand: 3,
          targetStockOnHand: 3,
          note: "Count",
        }),
    ]);
    const sold = results.slice(0, 6).filter((result) => result.status === "fulfilled").length;
    const damaged = results[6]!.status === "fulfilled" ? 1 : 0;
    // Not a test of nothing: some checkouts did get through.
    expect(sold).toBeGreaterThanOrEqual(1);
    // Three units existed: what left the shelf never exceeds them, and the balance says so.
    expect(sold + damaged).toBeLessThanOrEqual(3);
    // A count at "3" only applies while nothing has left yet, so it never adds stock back.
    expect(await stockOf(id)).toBe(3 - sold - damaged);
    expect(await stockOf(id)).toBeGreaterThanOrEqual(0);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("one order, four commands at the same version: exactly one wins, stock and coupon follow it", async () => {
    const a = await variant(10);
    const b = await variant(10);
    await db.coupon.create({
      data: { code: "RACE10", percentBps: 1000, active: true, updatedBy: ownerId },
    });
    for (let round = 0; round < 4; round++) {
      const orderId = await placed(
        [
          { variantId: a, quantity: 2 },
          { variantId: b, quantity: 1 },
        ],
        "RACE10",
      );
      const expectedVersion = await version(orderId);
      const before = { a: await stockOf(a), b: await stockOf(b) };
      const { won } = await race<unknown>([
        () =>
          cancelOrder(db, as(), orderId, {
            expectedVersion,
            commandId: randomUUID(),
            reason: "Race",
          }),
        () =>
          editOrder(db, as(), orderId, {
            expectedVersion,
            commandId: randomUUID(),
            lines: [{ variantId: a, quantity: 1 }],
          }),
        () =>
          transitionOrder(db, as(), orderId, {
            to: "confirmed",
            expectedVersion,
            commandId: randomUUID(),
          }),
        () =>
          editOrder(db, as(), orderId, {
            expectedVersion,
            commandId: randomUUID(),
            couponCode: null,
          }),
      ]);
      expect(won, `round ${round}`).toBe(1);
      const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
      // The version moved exactly once.
      expect(order.version).toBe(expectedVersion + 1);
      if (order.status === "cancelled") {
        expect(await stockOf(a)).toBe(before.a + 2);
        expect(await stockOf(b)).toBe(before.b + 1);
      }
    }
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await couponCountMismatches(db)).toEqual([]);
  });

  it("cancelling twice at once returns the stock once; the same command replays", async () => {
    const id = await variant(5);
    const orderId = await placed([{ variantId: id, quantity: 2 }]);
    const expectedVersion = await version(orderId);
    const same = randomUUID();
    const { won } = await race<unknown>([
      () => cancelOrder(db, as(), orderId, { expectedVersion, commandId: same, reason: "Twice" }),
      () => cancelOrder(db, as(), orderId, { expectedVersion, commandId: same, reason: "Twice" }),
      () =>
        cancelOrder(db, as(), orderId, {
          expectedVersion,
          commandId: randomUUID(),
          reason: "Other",
        }),
      () =>
        cancelOrder(db, as(), orderId, {
          expectedVersion,
          commandId: randomUUID(),
          reason: "Other",
        }),
    ]);
    expect(won).toBeGreaterThanOrEqual(1);
    expect(await stockOf(id)).toBe(5);
    expect(await db.orderCancellation.count({ where: { orderId } })).toBe(1);
    const returned = await db.stockMovement.count({ where: { orderId, reason: "ORDER_CANCEL" } });
    expect(returned).toBe(1);
  });

  it("the last coupon use goes to exactly one order, also against an edit adding it", async () => {
    const id = await variant(20);
    await db.coupon.create({
      data: { code: "ONCE10", percentBps: 1000, active: true, updatedBy: ownerId, usageLimit: 1 },
    });
    const existing = await placed([{ variantId: id, quantity: 1 }]);
    const commands = await Promise.all(
      Array.from({ length: 4 }, () => checkout([{ variantId: id, quantity: 1 }], "ONCE10")),
    );
    const expectedVersion = await version(existing);
    await race<unknown>([
      ...commands.map((command) => () => orders.place(command)),
      () =>
        editOrder(db, as(), existing, {
          expectedVersion,
          commandId: randomUUID(),
          couponCode: "ONCE10",
        }),
    ]);
    const coupon = await db.coupon.findUniqueOrThrow({ where: { code: "ONCE10" } });
    const live = await db.couponRedemption.count({
      where: { couponId: coupon.id, releasedAt: null },
    });
    expect(live).toBe(1);
    expect(await couponCountMismatches(db)).toEqual([]);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("cash is recorded once per order, whatever arrives together", async () => {
    const id = await variant(5);
    const orderId = await placed([{ variantId: id, quantity: 1 }]);
    for (const to of ["confirmed", "processing", "out_for_delivery", "delivered"] as const)
      await transitionOrder(db, as(), orderId, {
        to,
        expectedVersion: await version(orderId),
        commandId: randomUUID(),
      });
    const expectedVersion = await version(orderId);
    const same = randomUUID();
    await race<unknown>([
      () =>
        recordCollection(db, as(), orderId, { expectedVersion, commandId: same, amountFils: 6500 }),
      () =>
        recordCollection(db, as(), orderId, { expectedVersion, commandId: same, amountFils: 6500 }),
      () =>
        recordCollection(db, as(), orderId, {
          expectedVersion,
          commandId: randomUUID(),
          amountFils: 6500,
        }),
      () =>
        recordCollection(db, as(), orderId, {
          expectedVersion,
          commandId: randomUUID(),
          amountFils: 6000,
        }),
    ]);
    expect(await db.orderCollectionRecord.count({ where: { orderId } })).toBe(1);
    // Two corrections at the same version: one applies.
    const now = await version(orderId);
    const collectedAt = (
      await db.order.findUniqueOrThrow({ where: { id: orderId } })
    ).deliveredAt!.toISOString();
    const { won } = await race<unknown>([
      () =>
        correctCollection(db, as(), orderId, {
          expectedVersion: now,
          commandId: randomUUID(),
          reason: "Recount A",
          amountFils: 6400,
          reference: null,
          collectedAt,
        }),
      () =>
        correctCollection(db, as(), orderId, {
          expectedVersion: now,
          commandId: randomUUID(),
          reason: "Recount B",
          amountFils: 6300,
          reference: null,
          collectedAt,
        }),
    ]);
    expect(won).toBe(1);
    expect(await db.orderCollectionRecord.count({ where: { orderId } })).toBe(2);
  });

  it("one checkout key gives one order, the same payload replays and another is refused", async () => {
    const id = await variant(10);
    const sameKey = randomBytes(24).toString("base64url");
    const first = await checkout([{ variantId: id, quantity: 1 }], null, sameKey);
    const changed = {
      ...(await checkout([{ variantId: id, quantity: 2 }], null, sameKey)),
      contact: first.contact,
    };
    const { results } = await race<Awaited<ReturnType<CreateOrderService["place"]>>>([
      () => orders.place(first),
      () => orders.place({ ...first, requestId: randomUUID() }),
      () => orders.place({ ...first, requestId: randomUUID() }),
      () => orders.place(changed),
    ]);
    const ids = new Set(
      results
        .filter((result) => result.status === "fulfilled")
        .map((result) => (result as PromiseFulfilledResult<{ orderId?: string }>).value.orderId),
    );
    expect(ids.size).toBe(1);
    const sales = await db.stockMovement.count({ where: { variantId: id, reason: "SALE" } });
    expect(sales).toBe(1);
    expect(await stockOf(id)).toBe(9);
  });

  it("leaves the whole database consistent", async () => {
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await couponCountMismatches(db)).toEqual([]);
    const negative = await pool.query(
      "SELECT count(*)::int AS n FROM variants WHERE stock_on_hand < 0",
    );
    expect(negative.rows[0].n).toBe(0);
    // Every cancelled order has exactly one cancellation record and returned its stock once.
    const cancelled = await pool.query(`
      SELECT o.id,
        (SELECT count(*) FROM order_cancellations c WHERE c.order_id = o.id)::int AS records,
        (SELECT count(*) FROM stock_movements m WHERE m.order_id = o.id AND m.reason = 'ORDER_CANCEL')::int AS returns,
        (SELECT count(DISTINCT i.variant_id) FROM order_items i WHERE i.order_id = o.id)::int AS lines
      FROM orders o WHERE o.status = 'cancelled'`);
    for (const row of cancelled.rows as Array<{
      records: number;
      returns: number;
      lines: number;
    }>) {
      expect(row.records).toBe(1);
      expect(row.returns).toBe(row.lines);
    }
    // No coupon redemption of a cancelled order is still live.
    const live = await pool.query(`
      SELECT count(*)::int AS n FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
      WHERE o.status = 'cancelled' AND r.released_at IS NULL`);
    expect(live.rows[0].n).toBe(0);
  });
});
