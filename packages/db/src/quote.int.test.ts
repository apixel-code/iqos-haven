import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { CouponRejectedError, redeemCoupon } from "./coupons";
import { VariantUnavailableError } from "./pricing";
import { lockQuoteForOrder, previewQuote } from "./quote";
import { applyMigrations, seedOrder } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-quote-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
let staffId = "";
let areaId = "";
let closedAreaId = "";
async function variant(basePriceFils: bigint, stock = 0, overrideFils?: bigint) {
  const brand = await db.brand.create({
    data: { name: "Synthetic brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Synthetic category " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: "Synthetic product",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils,
      status: "published",
    },
  });
  const row = await db.variant.create({
    data: {
      productId: product.id,
      sku: key().toUpperCase(),
      active: true,
      isDefault: true,
      ...(overrideFils === undefined ? {} : { priceOverrideFils: overrideFils }),
    },
  });
  if (stock > 0)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [row.id, stock, randomUUID()],
    );
  return { id: row.id, productId: product.id };
}
const coupon = (
  code: string,
  percentBps: number,
  extra: { usageLimit?: number; minSubtotalFils?: bigint } = {},
) => db.coupon.create({ data: { code, percentBps, active: true, updatedBy: staffId, ...extra } });
const settled = async (work: Promise<unknown>, ms = 200) =>
  Promise.race([
    work.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
describe("quote assembly (real PostgreSQL, isolated schema)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findFirstOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: `quote-${randomUUID()}@iqoshaven.test`,
          name: "Seeder",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    const area = (code: string, emirate: string, active: boolean) =>
      db.deliveryArea.create({
        data: { code, name: "Synthetic " + code, emirate, active, updatedBy: staffId },
      });
    areaId = (await area("synthetic_open", "ajman", true)).id;
    closedAreaId = (await area("synthetic_closed", "dubai", false)).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("cannot quote before the Owner has configured delivery", async () => {
    const kit = await variant(12999n, 5);
    const lines = [{ variantId: kit.id, quantity: 1 }];
    await expect(previewQuote(db, { lines, areaId })).rejects.toBeInstanceOf(
      DeliveryUnconfiguredError,
    );
    // An unknown or inactive area is reported as such even then.
    await expect(previewQuote(db, { lines, areaId: closedAreaId })).rejects.toBeInstanceOf(
      DeliveryUnavailableError,
    );
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: staffId,
        value: { flatFeeFils: 1500, etaText: "Synthetic ETA", freeThresholdFils: null },
      },
    });
  });
  it("assembles a quote from server state only, with its references", async () => {
    const kit = await variant(12999n, 5);
    const pods = await variant(4000n, 5, 4500n);
    await coupon("QUOTE15", 1500);
    const quote = await previewQuote(db, {
      lines: [
        { variantId: pods.id, quantity: 1 },
        // Fields a client might add are not inputs: this price and fee are ignored.
        { variantId: kit.id, quantity: 1, unitPriceFils: 1, deliveryFeeFils: 0 } as never,
        { variantId: pods.id, quantity: 1 },
      ],
      areaId,
      couponCode: " quote15 ",
    });
    // 12999 + 2 × 4500 = 21999; 15 % = 3299.85 → 3300; + 1500 delivery.
    expect(quote).toMatchObject({
      merchandiseSubtotalFils: 21999,
      discountFils: 3300,
      deliveryFeeFils: 1500,
      totalFils: 20199,
      freeDeliveryThresholdFils: null,
      delivery: {
        areaId,
        areaCode: "synthetic_open",
        areaName: "Synthetic synthetic_open",
        emirate: "ajman",
        etaText: "Synthetic ETA",
        areaVersion: 1,
        configurationVersion: 1,
      },
      coupon: { code: "QUOTE15", percentBps: 1500, version: 1 },
      insufficientStock: [],
    });
    const byId = new Map(quote.lines.map((line) => [line.variantId, line]));
    expect(byId.get(kit.id)).toEqual({
      variantId: kit.id,
      productId: kit.productId,
      quantity: 1,
      unitPriceFils: 12999,
      subtotalFils: 12999,
      discountFils: 1950,
      totalFils: 11049,
      productVersion: 1,
      variantVersion: 1,
    });
    expect(byId.get(pods.id)).toMatchObject({
      quantity: 2,
      unitPriceFils: 4500,
      subtotalFils: 9000,
      discountFils: 1350,
    });
    expect(quote.lines.reduce((sum, line) => sum + line.totalFils, 0) + 1500).toBe(20199);
    // A preview uses nothing up.
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "QUOTE15" } })).activeRedemptions,
    ).toBe(0);
    // Without a code, and with a blank one, there is no discount.
    for (const couponCode of [undefined, null, "", "   "])
      expect(
        await previewQuote(db, { lines: [{ variantId: kit.id, quantity: 2 }], areaId, couponCode }),
      ).toMatchObject({ discountFils: 0, totalFils: 27498, coupon: null });
  });
  it("charges the same flat fee whatever the order is worth: free delivery is off", async () => {
    const cheap = await variant(100n, 5);
    const dear = await variant(1_000_000_000n, 5);
    for (const [variantId, quantity, total] of [
      [cheap.id, 1, 1600],
      [dear.id, 10, 10_000_001_500],
    ] as const)
      expect(await previewQuote(db, { lines: [{ variantId, quantity }], areaId })).toMatchObject({
        deliveryFeeFils: 1500,
        freeDeliveryThresholdFils: null,
        totalFils: total,
      });
    // The configuration cannot hold a threshold at all.
    await expect(
      pool.query(
        `UPDATE settings SET value=jsonb_set(value,'{freeThresholdFils}','15000') WHERE key='delivery'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("names lines that could not be filled now, without reserving anything", async () => {
    const plenty = await variant(4500n, 3);
    const low = await variant(4500n, 1);
    const none = await variant(4500n);
    const quote = await previewQuote(db, {
      lines: [
        { variantId: plenty.id, quantity: 3 },
        { variantId: low.id, quantity: 2 },
        { variantId: none.id, quantity: 1 },
      ],
      areaId,
    });
    expect([...quote.insufficientStock].sort()).toEqual([low.id, none.id].sort());
    expect(quote.totalFils).toBe(6 * 4500 + 1500);
    for (const id of [plenty.id, low.id, none.id])
      expect(await db.stockMovement.count({ where: { variantId: id, delta: { lt: 0 } } })).toBe(0);
    expect((await db.variant.findUniqueOrThrow({ where: { id: plenty.id } })).stockOnHand).toBe(3);
  });
  it("fails as a whole for a bad area, line or coupon", async () => {
    const kit = await variant(12999n, 5);
    const lines = [{ variantId: kit.id, quantity: 1 }];
    for (const bad of [closedAreaId, randomUUID(), "not-an-id", ""])
      await expect(previewQuote(db, { lines, areaId: bad })).rejects.toBeInstanceOf(
        DeliveryUnavailableError,
      );
    await expect(
      previewQuote(db, { lines: [...lines, { variantId: randomUUID(), quantity: 1 }], areaId }),
    ).rejects.toBeInstanceOf(VariantUnavailableError);
    await expect(previewQuote(db, { lines: [], areaId })).rejects.toMatchObject({
      problem: "EMPTY",
    });
    await expect(
      previewQuote(db, { lines: [{ variantId: kit.id, quantity: 11 }], areaId }),
    ).rejects.toMatchObject({ problem: "QUANTITY" });
    await expect(previewQuote(db, { lines, areaId, couponCode: "NOSUCH" })).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    await coupon("QUOTEMIN", 1000, { minSubtotalFils: 13000n });
    // The minimum is tested on merchandise before the discount; delivery does not count.
    await expect(
      previewQuote(db, { lines, areaId, couponCode: "QUOTEMIN" }),
    ).rejects.toBeInstanceOf(CouponRejectedError);
    expect(
      await previewQuote(db, {
        lines: [{ variantId: kit.id, quantity: 2 }],
        areaId,
        couponCode: "QUOTEMIN",
      }),
    ).toMatchObject({ discountFils: 2600 });
  });
  it("gives the order the same numbers under locks, and holds what it read", async () => {
    const kit = await variant(12999n, 5);
    await coupon("QUOTELOCK", 2000, { usageLimit: 1 });
    const input = { lines: [{ variantId: kit.id, quantity: 2 }], areaId, couponCode: "QUOTELOCK" };
    const preview = await previewQuote(db, input);
    await expect(lockQuoteForOrder(db as never, input)).rejects.toThrow("unit of work");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const { orderId } = await seedOrder(pool);
    const order = withTransaction(db, async (tx) => {
      const locked = await lockQuoteForOrder(tx, input);
      await redeemCoupon(tx, orderId, locked.appliedCoupon!);
      entered();
      await gate;
      return locked;
    });
    await inside;
    // Fee, area, price and coupon edits all wait for the order.
    const edits = [
      pool.query(
        `UPDATE settings SET value=jsonb_set(value,'{flatFeeFils}','9900'), version=version+1 WHERE key='delivery'`,
      ),
      pool.query("UPDATE delivery_areas SET active=false, version=version+1 WHERE id=$1", [areaId]),
      pool.query("UPDATE products SET base_price_fils=1 WHERE id=$1", [kit.productId]),
      pool.query("UPDATE coupons SET percent_bps=9000, version=version+1 WHERE code='QUOTELOCK'"),
    ];
    for (const edit of edits) expect(await settled(edit)).toBe(false);
    release();
    const { appliedCoupon, ...locked } = await order;
    const { insufficientStock, ...previewed } = preview;
    expect(insufficientStock).toEqual([]);
    expect(locked).toEqual(previewed);
    expect(appliedCoupon).toMatchObject({ code: "QUOTELOCK", discountFils: 5200 });
    expect(locked).toMatchObject({ discountFils: 5200, deliveryFeeFils: 1500, totalFils: 22298 });
    await Promise.all(edits);
    expect(await db.couponRedemption.findFirstOrThrow({ where: { orderId } })).toMatchObject({
      discountFils: 5200n,
      merchandiseSubtotalFils: 25998n,
    });
    // After the edits commit, the area is closed: the next quote is refused.
    await expect(previewQuote(db, input)).rejects.toBeInstanceOf(DeliveryUnavailableError);
    await pool.query("UPDATE delivery_areas SET active=true, version=version+1 WHERE id=$1", [
      areaId,
    ]);
    // And the coupon's single use is gone.
    await expect(previewQuote(db, input)).rejects.toMatchObject({ code: "COUPON_LIMIT_REACHED" });
    // A new quote shows the changed fee, price and versions: nothing is silently kept.
    expect(await previewQuote(db, { ...input, couponCode: null })).toMatchObject({
      deliveryFeeFils: 9900,
      merchandiseSubtotalFils: 2,
      totalFils: 9902,
      delivery: { areaVersion: 3, configurationVersion: 2 },
    });
  });
});
