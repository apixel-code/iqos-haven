import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { MetricRangeError } from "@ih/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { FinancialReadForbiddenError, readFinancialSummary } from "./financial-metrics";
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
  applicationName: "ih-financial-metrics-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
let ownerId = "";
let staffId = "";
const as = () => ({ requestId: randomUUID(), actorId: ownerId });
const version = async (orderId: string) =>
  (await db.order.findUniqueOrThrow({ where: { id: orderId } })).version;
/** Dubai calendar date `offsetDays` from now. */
const dubaiDate = (offsetDays: number) =>
  new Date(Date.now() + 4 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function deliver(orderId: string) {
  for (const to of ["processing", "out_for_delivery", "delivered"] as const)
    await transitionOrder(db, as(), orderId, {
      to,
      expectedVersion: await version(orderId),
      commandId: randomUUID(),
    });
}

describe("financial summary (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const user = async (key: string) =>
      (
        await db.staffUser.create({
          data: {
            email: `metrics-${key}@iqoshaven.test`,
            name: "Metrics " + key,
            roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
            passwordHash: HASH,
          },
        })
      ).id;
    ownerId = await user("owner");
    staffId = await user("staff");
    // A: placed, still pending: 5000 + 1500.
    await seedOrder(pool);
    // B: delivered, cash not yet collected: 10000 + 1500.
    const b = await seedOrder(pool, { status: "confirmed", quantity: 2 });
    await deliver(b.orderId);
    // C: delivered and collected 6500, then corrected to 6000: 5000 + 1500.
    const c = await seedOrder(pool, { status: "confirmed" });
    await deliver(c.orderId);
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
      // The database's own delivery time: after delivery and never in its future, whatever
      // the test machine's clock says.
      collectedAt: (
        await db.order.findUniqueOrThrow({ where: { id: c.orderId } })
      ).deliveredAt!.toISOString(),
    });
    // D: cancelled before handoff: 15000 + 1500.
    const d = await seedOrder(pool, { status: "confirmed", quantity: 3 });
    await cancelOrder(db, as(), d.orderId, {
      expectedVersion: await version(d.orderId),
      commandId: randomUUID(),
      reason: "Customer changed their mind",
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("keeps booked, delivered and collected apart, with labels and half-up averages", async () => {
    const summary = await readFinancialSummary(db, ownerId, {
      from: dubaiDate(-1),
      to: dubaiDate(1),
    });
    expect(summary).toMatchObject({
      range: { days: 3, timezone: "Asia/Dubai" },
      currency: "AED",
      definitionVersion: 1,
      booked: {
        active: {
          orders: 3,
          merchandiseNetFils: 20_000,
          deliveryFils: 4_500,
          totalFils: 24_500,
          aovFils: 8_167, // 24500 / 3 = 8166.67, half-up
        },
        cancelled: { orders: 1, totalFils: 16_500 },
      },
      delivered: {
        orders: 2,
        merchandiseNetFils: 15_000,
        deliveryFils: 3_000,
        totalFils: 18_000,
        aovFils: 9_000,
      },
      // The correction replaced the first record; it was not added to it.
      collected: { orders: 1, amountFils: 6_000, aovFils: 6_000 },
      cancellation: { placed: 4, cancelled: 1, rateBps: 2_500 },
      statusMix: {
        pending: 1,
        confirmed: 0,
        processing: 0,
        out_for_delivery: 0,
        delivered: 2,
        cancelled: 1,
      },
    });
    expect(summary.taxNote).toMatch(/no separate VAT/);
    for (const basis of [
      summary.booked,
      summary.delivered,
      summary.collected,
      summary.cancellation,
    ])
      expect(basis.dateBasis).toMatch(/Dubai day/);
  });

  it("counts nothing outside the days asked, and has no average for no orders", async () => {
    const summary = await readFinancialSummary(db, ownerId, {
      from: dubaiDate(-5),
      to: dubaiDate(-2),
    });
    expect(summary.booked.active).toEqual({
      orders: 0,
      merchandiseNetFils: 0,
      deliveryFils: 0,
      totalFils: 0,
      aovFils: null,
    });
    expect(summary.collected).toMatchObject({ orders: 0, amountFils: 0, aovFils: null });
    expect(summary.cancellation.rateBps).toBeNull();
  });

  it("cuts days at Dubai midnight (20:00 UTC)", async () => {
    const placed = await seedOrder(pool);
    // Just before and just after midnight Dubai between 2026-03-09 and 2026-03-10.
    await pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
    try {
      await pool.query("UPDATE orders SET created_at=$1 WHERE id=$2", [
        "2026-03-09T19:59:59.999Z",
        placed.orderId,
      ]);
      const other = await seedOrder(pool);
      await pool.query("UPDATE orders SET created_at=$1 WHERE id=$2", [
        "2026-03-09T20:00:00.000Z",
        other.orderId,
      ]);
    } finally {
      await pool.query("ALTER TABLE orders ENABLE TRIGGER USER");
    }
    const ninth = await readFinancialSummary(db, ownerId, { from: "2026-03-09", to: "2026-03-09" });
    const tenth = await readFinancialSummary(db, ownerId, { from: "2026-03-10", to: "2026-03-10" });
    expect(ninth.booked.active.orders).toBe(1);
    expect(tenth.booked.active.orders).toBe(1);
  });

  it("is the Owner's, and refuses impossible ranges", async () => {
    await expect(
      readFinancialSummary(db, staffId, { from: dubaiDate(-1), to: dubaiDate(0) }),
    ).rejects.toBeInstanceOf(FinancialReadForbiddenError);
    for (const [from, to] of [
      ["2026-02-30", "2026-03-01"],
      [dubaiDate(0), dubaiDate(-1)],
      ["2024-01-01", "2026-01-01"],
    ])
      await expect(
        readFinancialSummary(db, ownerId, { from: from!, to: to! }),
      ).rejects.toBeInstanceOf(MetricRangeError);
  });
});
