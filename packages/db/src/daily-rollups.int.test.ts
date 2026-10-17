import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { orderRollupDays, rollupDay } from "./daily-rollups";
import { readFinancialSummary } from "./financial-metrics";
import { cancelOrder } from "./order-cancellation";
import { correctCollection, recordCollection } from "./order-collection";
import { transitionOrder } from "./order-transitions";
import { applyMigrations, seedOrder } from "./test-schema";

loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-daily-rollups-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
let ownerId = "";
let collectedOrder = "";
let productB = "";
const as = () => ({ requestId: randomUUID(), actorId: ownerId });
const version = async (orderId: string) =>
  (await db.order.findUniqueOrThrow({ where: { id: orderId } })).version;
/** Today's Dubai date (the day every seeded row falls on). */
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
async function deliver(orderId: string) {
  for (const to of ["processing", "out_for_delivery", "delivered"] as const)
    await transitionOrder(db, as(), orderId, {
      to,
      expectedVersion: await version(orderId),
      commandId: randomUUID(),
    });
}
const rows = async () => ({
  sales: await db.salesDaily.findMany(),
  products: await db.productSalesDaily.findMany({ orderBy: [{ productId: "asc" }] }),
  search: await db.searchDaily.findMany({ orderBy: { term: "asc" } }),
  wishlist: await db.wishlistDaily.findMany(),
});
const plain = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key === "computedAt" ? undefined : typeof item === "bigint" ? Number(item) : item,
    ),
  ) as unknown;

describe("daily rollups (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "rollup-owner@iqoshaven.test",
          name: "Rollup Owner",
          roleId: (await db.role.findUniqueOrThrow({ where: { key: "owner" } })).id,
          passwordHash: HASH,
        },
      })
    ).id;
    await seedOrder(pool); // A: pending, 5000 + 1500
    const b = await seedOrder(pool, { status: "confirmed", quantity: 2 }); // B: delivered
    await deliver(b.orderId);
    productB = (await db.orderItem.findFirstOrThrow({ where: { orderId: b.orderId } })).productId;
    const c = await seedOrder(pool, { status: "confirmed" }); // C: delivered, collected, corrected
    await deliver(c.orderId);
    collectedOrder = c.orderId;
    await recordCollection(db, as(), c.orderId, {
      expectedVersion: await version(c.orderId),
      commandId: randomUUID(),
      amountFils: 6500,
    });
    await correctCollection(db, as(), c.orderId, {
      expectedVersion: await version(c.orderId),
      commandId: randomUUID(),
      reason: "Counted again",
      amountFils: 6000,
      reference: null,
      collectedAt: (
        await db.order.findUniqueOrThrow({ where: { id: c.orderId } })
      ).deliveredAt!.toISOString(),
    });
    const d = await seedOrder(pool, { status: "confirmed", quantity: 3 }); // D: cancelled
    await cancelOrder(db, as(), d.orderId, {
      expectedVersion: await version(d.orderId),
      commandId: randomUUID(),
      reason: "Changed mind",
    });
    // Browsing events (step 103): two searches for one term, one zero-result, one not kept.
    const event = (type: string, payload: object) =>
      pool.query("INSERT INTO events (id, type, payload) VALUES ($1, $2, $3)", [
        randomUUID(),
        type,
        JSON.stringify(payload),
      ]);
    await event("search", { term: "grape", resultCount: 3 });
    await event("search", { term: "grape", resultCount: 0 });
    await event("search", { term: null, resultCount: 1 });
    await event("wishlist_add", { productId: productB });
    await event("wishlist_add", { productId: productB });
    await event("wishlist_remove", { productId: productB });
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("writes one day of all four tables, matching the step 105 definitions", async () => {
    await rollupDay(db, today());
    const { sales, products, search, wishlist } = await rows();
    const summary = await readFinancialSummary(db, ownerId, { from: today(), to: today() });
    expect(sales).toHaveLength(1);
    expect(plain(sales[0])).toMatchObject({
      placedOrders: 4,
      cancelledOrders: 1,
      bookedOrders: summary.booked.active.orders,
      bookedNetFils: summary.booked.active.merchandiseNetFils,
      bookedDeliveryFils: summary.booked.active.deliveryFils,
      bookedTotalFils: summary.booked.active.totalFils,
      cancelledTotalFils: summary.booked.cancelled.totalFils,
      deliveredOrders: summary.delivered.orders,
      deliveredNetFils: summary.delivered.merchandiseNetFils,
      deliveredTotalFils: summary.delivered.totalFils,
      collectedOrders: 1,
      collectedFils: 6000,
      definitionVersion: 1,
    });
    // Ordered: A, B, C (not the cancelled D); delivered: B and C.
    expect(products.reduce((sum, row) => sum + row.orderedUnits, 0)).toBe(4);
    expect(products.reduce((sum, row) => sum + row.deliveredUnits, 0)).toBe(3);
    expect(plain(products.find((row) => row.productId === productB))).toMatchObject({
      orderedUnits: 2,
      orderedNetFils: 10_000,
      deliveredUnits: 2,
      deliveredNetFils: 10_000,
      deliveredDiscountFils: 0,
    });
    expect(plain(search)).toEqual([
      expect.objectContaining({ term: "", searches: 1, zeroResults: 0, resultTotal: 1 }),
      expect.objectContaining({ term: "grape", searches: 2, zeroResults: 1, resultTotal: 3 }),
    ]);
    expect(plain(wishlist)).toEqual([
      expect.objectContaining({ productId: productB, adds: 2, removes: 1 }),
    ]);
  });

  it("gives the same rows when run again, also several at once", async () => {
    const before = plain(await rows());
    await rollupDay(db, today());
    await Promise.all([rollupDay(db, today()), rollupDay(db, today()), rollupDay(db, today())]);
    expect(plain(await rows())).toEqual(before);
  });

  it("keeps the brand each sale was made under", async () => {
    // The order item's snapshot, not the catalogue's current brand name.
    const item = await db.orderItem.findFirstOrThrow({ where: { productId: productB } });
    const brand = await pool.query(
      "SELECT b.id FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.id=$1",
      [productB],
    );
    await pool.query("UPDATE brands SET name=$1, version=version+1 WHERE id=$2", [
      "Renamed " + randomUUID().slice(0, 8),
      brand.rows[0].id,
    ]);
    await rollupDay(db, today());
    const row = await db.productSalesDaily.findFirstOrThrow({ where: { productId: productB } });
    expect(row.brandName).toBe(item.brandName);
    expect(row.brandName).not.toMatch(/^Renamed /);
  });

  it("knows which days an order touches, and refuses an impossible day", async () => {
    expect(await orderRollupDays(db, collectedOrder)).toEqual([today()]);
    expect(await orderRollupDays(db, randomUUID())).toEqual([]);
    await expect(rollupDay(db, "2026-02-30")).rejects.toThrow();
    // Past the raw-event retention, a recompute keeps that day's search and saved-list rows.
    await pool.query(
      "INSERT INTO search_daily (day, term, searches, zero_results, result_total) VALUES ('2020-01-01', 'kept', 4, 1, 9)",
    );
    // A day with nothing gives an all-zero sales row and no other rows.
    await rollupDay(db, "2020-01-01");
    const empty = await db.salesDaily.findUniqueOrThrow({ where: { day: new Date("2020-01-01") } });
    expect(empty.placedOrders).toBe(0);
    expect(await db.productSalesDaily.count({ where: { day: new Date("2020-01-01") } })).toBe(0);
    expect(await db.searchDaily.count({ where: { day: new Date("2020-01-01") } })).toBe(1);
  });
});
