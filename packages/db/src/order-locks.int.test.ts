import { randomBytes, randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool, type Tx } from "./client";
import { lockCouponForOrder } from "./coupons";
import { lockCustomerForOrder, markCustomerFirstOrder, saveCustomerAddress } from "./customers";
import { lockDeliverySelection } from "./delivery";
import { canonicalPayloadHash, claimIdempotency } from "./idempotency";
import {
  lockForOrderCreation,
  lockOrder,
  lockVariantsForStock,
  OrderNotFoundError,
} from "./order-locks";
import { lockOrderPrices, VariantUnavailableError } from "./pricing";
import { applyMigrations, seedOrder } from "./test-schema";
import {
  LOCK_GROUPS,
  LockOrderError,
  reachedLockGroup,
  TransactionContentionError,
  withTransaction,
} from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-order-locks-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
/** Admin-side connections of their own, so they never queue behind the order walks' pool. */
const adminPool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-order-locks-admin",
  searchPath: namespace,
});
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
let staffId = "";
let areaId = "";
let serial = 0;
const phone = () => "+97150700" + String(++serial).padStart(4, "0");
async function variant(basePriceFils: bigint, stock: number) {
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
    data: { productId: product.id, sku: key().toUpperCase(), active: true, isDefault: true },
  });
  if (stock > 0)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [row.id, stock, randomUUID()],
    );
  return { id: row.id, productId: product.id, brandId: brand.id };
}
const claim = (tx: Tx) =>
  claimIdempotency(tx, {
    scope: "store.checkout",
    key: randomBytes(24).toString("base64url"),
    payloadHash: canonicalPayloadHash({ n: randomUUID() }),
  });
/** Rolls back on purpose: these tests are about locks, not about what gets written. */
const STOP = new Error("synthetic stop");
const walk = <T>(work: (tx: Tx) => Promise<T>) => {
  let value!: T;
  return withTransaction(db, async (tx) => {
    value = await work(tx);
    throw STOP;
  }).catch((error: unknown) => {
    if (error !== STOP) throw error;
    return value;
  });
};
const violation = async (work: (tx: Tx) => Promise<unknown>) => {
  const error = await walk(work).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LockOrderError);
  return error as LockOrderError;
};
const waiting = async (pattern: string, count = 1) => {
  for (let n = 0; n < 200; n++) {
    const found = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='ih-order-locks-test' AND wait_event_type='Lock' AND query LIKE $1",
      [pattern],
    );
    if (found.rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected a transaction to wait on a lock");
};
describe("canonical lock order (real PostgreSQL, isolated schema)", () => {
  let a: Awaited<ReturnType<typeof variant>>;
  let b: Awaited<ReturnType<typeof variant>>;
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findFirstOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: `locks-${randomUUID()}@iqoshaven.test`,
          name: "Seeder",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "synthetic_locks",
          name: "Synthetic locks",
          emirate: "dubai",
          active: true,
          updatedBy: staffId,
        },
      })
    ).id;
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: staffId,
        value: { flatFeeFils: 1500, etaText: "Synthetic ETA", freeThresholdFils: null },
      },
    });
    await db.coupon.create({
      data: { code: "LOCKS10", percentBps: 1000, active: true, updatedBy: staffId },
    });
    [a, b] = [await variant(5000n, 50), await variant(7000n, 50)].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    ) as [typeof a, typeof b];
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await adminPool.end();
    await pool.end();
  });
  const order = (first: string, second: string) => ({
    customer: { phone: phone(), displayName: "Synthetic Buyer" },
    quote: {
      lines: [
        { variantId: first, quantity: 1 },
        { variantId: second, quantity: 2 },
      ],
      areaId,
      couponCode: "LOCKS10",
    },
  });
  it("walks every group front to back for an order creation", async () => {
    const stages: Array<string | null> = [];
    const seeded = await seedOrder(pool);
    const result = await walk(async (tx) => {
      stages.push(reachedLockGroup(tx));
      await claim(tx);
      stages.push(reachedLockGroup(tx));
      await lockOrder(tx, seeded.orderId);
      stages.push(reachedLockGroup(tx));
      const locked = await lockForOrderCreation(tx, order(b.id, a.id));
      stages.push(reachedLockGroup(tx));
      return locked;
    });
    expect(stages).toEqual([null, "idempotency", "order", "variants"]);
    expect(LOCK_GROUPS).toEqual([
      "idempotency",
      "order",
      "customer",
      "delivery",
      "catalogue",
      "coupon",
      "variants",
    ]);
    // What an order needs, read under the locks: customer, quote and the variants with stock.
    expect(result.customerCreated).toBe(true);
    // One of b (70.00) and two of a (50.00): 170.00, 10 % off, + 15.00 delivery.
    expect(result.quote).toMatchObject({
      merchandiseSubtotalFils: 17000,
      discountFils: 1700,
      deliveryFeeFils: 1500,
      totalFils: 16800,
    });
    expect(result.quote.appliedCoupon).toMatchObject({ code: "LOCKS10" });
    expect(result.variants).toEqual([
      {
        variantId: a.id,
        productId: a.productId,
        stockOnHand: 50,
        active: true,
        version: 1,
        lowStockThreshold: 0,
      },
      {
        variantId: b.id,
        productId: b.productId,
        stockOnHand: 50,
        active: true,
        version: 1,
        lowStockThreshold: 0,
      },
    ]);
  });
  it("refuses any group requested after a later one, before a statement runs", async () => {
    const lines = [{ variantId: a.id, quantity: 1 }];
    const steps: Record<string, (tx: Tx) => Promise<unknown>> = {
      idempotency: (tx) => claim(tx),
      order: (tx) =>
        lockOrder(tx, randomUUID()).catch((error: unknown) => {
          if (error instanceof OrderNotFoundError) return null;
          throw error;
        }),
      customer: (tx) => lockCustomerForOrder(tx, { phone: phone(), displayName: "Synthetic" }),
      delivery: (tx) => lockDeliverySelection(tx, areaId),
      catalogue: (tx) => lockOrderPrices(tx, lines),
      coupon: (tx) => lockCouponForOrder(tx, "LOCKS10", 5000),
      variants: (tx) => lockVariantsForStock(tx, [a.id]),
    };
    for (const [later, laterIndex] of LOCK_GROUPS.map((group, index) => [group, index] as const))
      for (const earlier of LOCK_GROUPS.slice(0, laterIndex)) {
        const error = await violation(async (tx) => {
          await steps[later]!(tx);
          await steps[earlier]!(tx);
        });
        expect(error, `${earlier} after ${later}`).toMatchObject({
          attempted: earlier,
          after: later,
        });
      }
    // The same group again, and skipping groups, are both fine.
    await walk(async (tx) => {
      await steps.customer!(tx);
      await steps.customer!(tx);
      await steps.coupon!(tx);
      await steps.variants!(tx);
      await steps.variants!(tx);
    });
    // A refused step ran no statement: inside the same transaction, the customer it would have
    // created is not there.
    const number = phone();
    let seenInside = -1;
    await violation(async (tx) => {
      await steps.variants!(tx);
      try {
        await lockCustomerForOrder(tx, { phone: number, displayName: "Never Created" });
      } catch (error) {
        seenInside = await tx.customer.count({ where: { phoneE164: number } });
        throw error;
      }
    });
    expect(seenInside).toBe(0);
    // Not something to retry: it is a programming error, not contention.
    await expect(lockVariantsForStock(db as never, [a.id])).rejects.toThrow("unit of work");
  });
  it("saves an address after the area lock only for a customer the transaction already holds", async () => {
    const address = { areaId, type: "villa" as const, building: "Synthetic Villa 3" };
    const number = phone();
    // In an order: customer first, area next, then the address.
    const saved = await withTransaction(db, async (tx) => {
      const { customer } = await lockCustomerForOrder(tx, {
        phone: number,
        displayName: "Synthetic",
      });
      await lockDeliverySelection(tx, areaId);
      return { customer, ...(await saveCustomerAddress(tx, customer.id, address)) };
    });
    expect(saved.created).toBe(true);
    // On its own it takes the customer lock itself.
    expect(
      await withTransaction(db, (tx) => saveCustomerAddress(tx, saved.customer.id, address)),
    ).toMatchObject({ created: false });
    // After the area lock, for a customer not yet locked: that would be the wrong order.
    await violation(async (tx) => {
      await lockDeliverySelection(tx, areaId);
      await saveCustomerAddress(tx, saved.customer.id, address);
    });
    // An address saved before the delivery selection has already referenced the area, so the
    // settings lock can no longer be taken in order.
    await violation(async (tx) => {
      const { customer } = await lockCustomerForOrder(tx, {
        phone: number,
        displayName: "Synthetic",
      });
      await saveCustomerAddress(tx, customer.id, { ...address, building: "Synthetic Villa 4" });
      await lockDeliverySelection(tx, areaId);
    });
    // The first order is stamped only for a customer this transaction holds.
    await expect(walk((tx) => markCustomerFirstOrder(tx, saved.customer.id))).rejects.toThrow(
      "locked in this unit of work",
    );
  });
  it("locks variants in ID order whatever order they were asked in", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    // One transaction holds the larger ID.
    const holder = walk(async (tx) => {
      await lockVariantsForStock(tx, [b.id]);
      entered();
      await gate;
    });
    await inside;
    // Another asks for [larger, smaller]: it must take the smaller first and then wait.
    const asker = walk((tx) => lockVariantsForStock(tx, [b.id.toUpperCase(), a.id, b.id]));
    await waiting("%FROM variants WHERE id = ANY%");
    await expect(
      pool.query("SELECT id FROM variants WHERE id=$1 FOR UPDATE NOWAIT", [a.id]),
    ).rejects.toMatchObject({ code: "55P03" });
    release();
    await holder;
    expect((await asker).map((row) => row.variantId)).toEqual([a.id, b.id]);
    // Unknown variants fail the command and are named; an empty request locks nothing.
    const unknown = randomUUID();
    const error = await walk((tx) => lockVariantsForStock(tx, [a.id, unknown])).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(VariantUnavailableError);
    expect((error as VariantUnavailableError).variantIds).toEqual([unknown]);
    expect(await walk((tx) => lockVariantsForStock(tx, []))).toEqual([]);
  });
  it("runs two commands on one order one after the other", async () => {
    const seeded = await seedOrder(pool);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const sequence: string[] = [];
    const first = walk(async (tx) => {
      const locked = await lockOrder(tx, seeded.orderId);
      entered();
      await gate;
      sequence.push("first");
      return locked;
    });
    await inside;
    const second = walk(async (tx) => {
      const locked = await lockOrder(tx, seeded.orderId);
      sequence.push("second");
      return locked;
    });
    await waiting("%FROM orders WHERE id=%");
    expect(sequence).toEqual([]);
    release();
    expect(await first).toMatchObject({
      id: seeded.orderId,
      orderNumber: String(seeded.orderNumber),
      status: "pending",
      version: 1,
      codStatus: "pending",
    });
    await second;
    expect(sequence).toEqual(["first", "second"]);
    await expect(walk((tx) => lockOrder(tx, randomUUID()))).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
  });
  it("never deadlocks: orders in both line orders race the admin's own lock sequences", async () => {
    // Admin commands as the admin code locks them, each in one transaction on its own
    // connection, with no retry: a deadlock here surfaces as PostgreSQL error 40P01.
    const adminSequences: Array<Array<[string, unknown[]]>> = [
      // Product edit: parents FOR SHARE, the product FOR UPDATE, then its variants in ID order.
      [
        ["SELECT id FROM brands WHERE id=$1 FOR SHARE", [a.brandId]],
        ["SELECT id FROM products WHERE id=$1 FOR UPDATE", [a.productId]],
        ["UPDATE products SET base_price_fils=base_price_fils WHERE id=$1", [a.productId]],
        ["SELECT id FROM variants WHERE product_id=$1 ORDER BY id FOR UPDATE", [a.productId]],
        [
          "UPDATE variants SET low_stock_threshold=low_stock_threshold WHERE product_id=$1",
          [a.productId],
        ],
      ],
      [
        ["SELECT id FROM products WHERE id=$1 FOR UPDATE", [b.productId]],
        ["SELECT id FROM variants WHERE product_id=$1 ORDER BY id FOR UPDATE", [b.productId]],
      ],
      // Brand edit, fee edit, area edit, coupon edit: one row each.
      [["SELECT id FROM brands WHERE id=$1 FOR UPDATE", [b.brandId]]],
      [
        ["SELECT key FROM settings WHERE key='delivery' FOR UPDATE", []],
        ["UPDATE settings SET version=version+1 WHERE key='delivery'", []],
      ],
      [
        ["SELECT id FROM delivery_areas WHERE id=$1 FOR UPDATE", [areaId]],
        ["UPDATE delivery_areas SET version=version+1 WHERE id=$1", [areaId]],
      ],
      [
        ["SELECT id FROM coupons WHERE code='LOCKS10' FOR UPDATE", []],
        ["UPDATE coupons SET version=version+1 WHERE code='LOCKS10'", []],
      ],
      // Stock adjustment: the variant row, then the ledger insert that updates it.
      [
        ["SELECT id FROM variants WHERE id=$1 FOR UPDATE", [b.id]],
        [
          "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) SELECT id, 1, stock_on_hand+1, 'RESTOCK', $2 FROM variants WHERE id=$1",
          [b.id, null],
        ],
      ],
    ];
    const runAdmin = async (statements: Array<[string, unknown[]]>) => {
      const client = await adminPool.connect();
      try {
        await client.query("BEGIN");
        for (const [sql, params] of statements)
          await client.query(
            sql,
            params.map((value) => (value === null ? randomUUID() : value)),
          );
        // Hold the locks briefly so the order walks really meet them.
        await client.query("SELECT pg_sleep(0.02)");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    const errors: unknown[] = [];
    let walks = 0;
    let attempts = 0;
    for (let round = 0; round < 5; round++) {
      const orders = Array.from({ length: 6 }, (_, n) => {
        walks++;
        // Half the orders list the variants one way, half the other; all share the coupon.
        return walk((tx) => {
          attempts++;
          return lockForOrderCreation(tx, n % 2 ? order(a.id, b.id) : order(b.id, a.id));
        });
      });
      const results = await Promise.allSettled([...orders, ...adminSequences.map(runAdmin)]);
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    }
    // No admin command was a deadlock victim (or failed at all), no order walk was refused,
    // and no order walk was retried: `withTransaction` reruns the callback after a deadlock,
    // so one attempt per walk means none was ever chosen as a victim.
    expect(errors.map((error) => (error as { code?: string }).code ?? String(error))).toEqual([]);
    expect(errors.filter((error) => error instanceof TransactionContentionError)).toEqual([]);
    expect(attempts).toBe(walks);
  });
});
