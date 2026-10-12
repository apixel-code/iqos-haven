import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import {
  lockOrderPrices,
  priceOrderLines,
  readOrderPrices,
  VariantUnavailableError,
} from "./pricing";
import { applyMigrations } from "./test-schema";
import {
  TransactionContentionError,
  TransactionRestartError,
  withTransaction,
} from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-pricing-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
/** A published product with one active default variant and, optionally, an override variant. */
async function product(basePriceFils: bigint, overrideFils?: bigint) {
  const brand = await db.brand.create({
    data: { name: "Synthetic brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Synthetic category " + key(), slug: key(), active: true },
  });
  const row = await db.product.create({
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
  const base = await db.variant.create({
    data: { productId: row.id, sku: key().toUpperCase(), active: true, isDefault: true },
  });
  const override =
    overrideFils === undefined
      ? null
      : await db.variant.create({
          data: {
            productId: row.id,
            sku: key().toUpperCase(),
            attributes: { colour: "red" },
            active: true,
            priceOverrideFils: overrideFils,
          },
        });
  return { brand, category, row, base, override };
}
const unavailable = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(VariantUnavailableError);
  return (error as VariantUnavailableError).variantIds;
};
const settled = async (work: Promise<unknown>, ms = 200) =>
  Promise.race([
    work.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
describe("order prices (real PostgreSQL, isolated schema)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("reads the variant override or the product price, never a client value", async () => {
    const kit = await product(12999n, 14999n);
    const other = await product(4500n);
    const lines = await readOrderPrices(db, [
      // Client-supplied fields are not part of the input type and are ignored if present.
      { variantId: kit.override!.id, quantity: 1, unitPriceFils: 1 } as never,
      { variantId: other.base.id, quantity: 2 },
      { variantId: kit.base.id, quantity: 1 },
      { variantId: other.base.id.toUpperCase(), quantity: 1 },
    ]);
    const byId = new Map(lines.map((line) => [line.variantId, line]));
    expect(lines.map((line) => line.variantId)).toEqual([...byId.keys()].sort());
    expect(byId.get(kit.base.id)).toMatchObject({
      productId: kit.row.id,
      quantity: 1,
      unitPriceFils: 12999,
      productVersion: 1,
      variantVersion: 1,
    });
    expect(byId.get(kit.override!.id)).toMatchObject({ unitPriceFils: 14999 });
    expect(byId.get(other.base.id)).toMatchObject({ quantity: 3, unitPriceFils: 4500 });
    expect(Object.keys(lines[0]!).sort()).toEqual([
      "productId",
      "productVersion",
      "quantity",
      "unitPriceFils",
      "variantId",
      "variantVersion",
    ]);
    const priced = priceOrderLines(lines, { discountBasisPoints: 1000, deliveryFeeFils: 1500 });
    // 12999 + 14999 + 3 × 4500 = 41498; 10 % = 4149.8 → 4150.
    expect(priced).toMatchObject({
      merchandiseSubtotalFils: 41498,
      discountFils: 4150,
      deliveryFeeFils: 1500,
      totalFils: 38848,
    });
  });
  it("refuses lines a shopper cannot see, naming them", async () => {
    const good = await product(4500n);
    const draft = await product(4500n);
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [draft.row.id]);
    const inactive = await product(4500n, 5000n);
    await pool.query("UPDATE variants SET active=false WHERE id=$1", [inactive.override!.id]);
    const hiddenBrand = await product(4500n);
    await pool.query("UPDATE brands SET active=false WHERE id=$1", [hiddenBrand.brand.id]);
    const hiddenCategory = await product(4500n);
    await pool.query("UPDATE categories SET active=false WHERE id=$1", [
      hiddenCategory.category.id,
    ]);
    const unknown = randomUUID();
    const bad = [
      draft.base.id,
      inactive.override!.id,
      hiddenBrand.base.id,
      hiddenCategory.base.id,
      unknown,
    ];
    const named = await unavailable(
      readOrderPrices(
        db,
        [good.base.id, ...bad].map((variantId) => ({ variantId, quantity: 1 })),
      ),
    );
    expect([...named].sort()).toEqual([...bad].sort());
    expect(
      await unavailable(
        withTransaction(db, (tx) => lockOrderPrices(tx, [{ variantId: unknown, quantity: 1 }])),
      ),
    ).toEqual([unknown]);
    // The other variant of that product is still sold.
    expect(await readOrderPrices(db, [{ variantId: inactive.base.id, quantity: 1 }])).toHaveLength(
      1,
    );
  });
  it("applies the quantity caps before reading anything", async () => {
    const kit = await product(4500n);
    await expect(readOrderPrices(db, [])).rejects.toMatchObject({ problem: "EMPTY" });
    await expect(
      readOrderPrices(db, [
        { variantId: kit.base.id, quantity: 6 },
        { variantId: kit.base.id, quantity: 5 },
      ]),
    ).rejects.toMatchObject({ problem: "QUANTITY" });
  });
  it("starts the transaction again when asked to, and gives up after three attempts", async () => {
    const kit = await product(4500n);
    let attempts = 0;
    const lines = await withTransaction(db, async (tx) => {
      const locked = await lockOrderPrices(tx, [{ variantId: kit.base.id, quantity: 1 }]);
      if (++attempts < 3) throw new TransactionRestartError("synthetic catalogue move");
      return locked;
    });
    expect(attempts).toBe(3);
    expect(lines).toHaveLength(1);
    attempts = 0;
    await expect(
      withTransaction(db, async () => {
        attempts++;
        throw new TransactionRestartError("synthetic catalogue move");
      }),
    ).rejects.toBeInstanceOf(TransactionContentionError);
    expect(attempts).toBe(3);
  });
  it("freezes price and visibility until the order commits", async () => {
    const kit = await product(12999n, 14999n);
    const lines = [
      { variantId: kit.base.id, quantity: 1 },
      { variantId: kit.override!.id, quantity: 1 },
    ];
    await expect(lockOrderPrices(db as never, lines)).rejects.toThrow("unit of work");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const order = withTransaction(db, async (tx) => {
      const locked = await lockOrderPrices(tx, lines);
      entered();
      await gate;
      return locked;
    });
    await inside;
    // The edits an admin command makes: each takes the product (or a parent) row first.
    const priceEdit = pool.query("UPDATE products SET base_price_fils=99999 WHERE id=$1", [
      kit.row.id,
    ]);
    const hide = pool.query("UPDATE brands SET active=false WHERE id=$1", [kit.brand.id]);
    const categoryEdit = pool.query("UPDATE categories SET active=false WHERE id=$1", [
      kit.category.id,
    ]);
    expect(await settled(Promise.all([priceEdit, hide, categoryEdit]))).toBe(false);
    // A second order of the same variants is not held up by the first.
    expect(
      await settled(
        withTransaction(db, (tx) => lockOrderPrices(tx, lines)),
        2000,
      ),
    ).toBe(true);
    release();
    expect((await order).map((line) => line.unitPriceFils)).toEqual(
      [kit.base.id, kit.override!.id].sort().map((id) => (id === kit.base.id ? 12999 : 14999)),
    );
    await Promise.all([priceEdit, hide, categoryEdit]);
    // After the edits commit the product is hidden, so the next order is refused.
    await unavailable(withTransaction(db, (tx) => lockOrderPrices(tx, lines)));
  });
});
