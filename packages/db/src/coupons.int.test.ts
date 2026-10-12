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
  couponCountMismatches,
  CouponRejectedError,
  lockCouponForOrder,
  previewCoupon,
  redeemCoupon,
  releaseCouponRedemption,
} from "./coupons";
import { lockOrder } from "./order-locks";
import { applyMigrations, seedOrder } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-coupons-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
let staffId = "";
let serial = 0;
const code = () => "SYN" + String(++serial).padStart(4, "0");
interface CouponSeed {
  percentBps?: number;
  active?: boolean;
  minSubtotalFils?: bigint;
  startsAt?: Date;
  expiresAt?: Date;
  usageLimit?: number;
}
const coupon = (seed: CouponSeed = {}) =>
  db.coupon.create({
    data: { code: code(), percentBps: 1000, active: true, updatedBy: staffId, ...seed },
  });
const rejected = (sql: string, params: unknown[] = [], pg = "23514") =>
  expect(pool.query(sql, params)).rejects.toMatchObject({ code: pg });
const reason = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CouponRejectedError);
  return (error as CouponRejectedError).reason;
};
/** One order using a coupon: lock, then redeem, in one transaction. */
/** A real order row to hang a redemption on (the order_id foreign key, step 73). */
const anOrder = async () => (await seedOrder(pool)).orderId;
const order = async (couponCode: string, subtotal: number, existing?: string) => {
  const orderId = existing ?? (await anOrder());
  return withTransaction(db, async (tx) => {
    const applied = await lockCouponForOrder(tx, couponCode, subtotal);
    await redeemCoupon(tx, orderId, applied);
    return { orderId, applied };
  });
};
const uses = async (id: string) =>
  (await db.coupon.findUniqueOrThrow({ where: { id } })).activeRedemptions;
describe("coupons and redemptions (real PostgreSQL, isolated schema)", () => {
  let runtimeRole = false;
  beforeAll(async () => {
    runtimeRole =
      (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ih_app'")).rowCount === 1;
    if (process.env.CI) expect(runtimeRole).toBe(true);
    await applyMigrations(pool, namespace, runtimeRole ? { runtimeRole: "ih_app" } : {});
    const role = await db.role.findFirstOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: `coupons-${randomUUID()}@iqoshaven.test`,
          name: "Seeder",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("adds two empty tables and no seeded coupon", async () => {
    for (const table of ["coupons", "coupon_redemptions"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it("enforces the coupon shape in the database", async () => {
    const insert =
      "INSERT INTO coupons (code,percent_bps,min_subtotal_fils,usage_limit,updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id";
    for (const bad of ["save10", "AB", "TWO CODES", "A".repeat(33), "-X1"])
      await rejected(insert, [bad, 1000, 0, null, staffId], bad.length > 32 ? "22001" : "23514");
    for (const bps of [0, -1, 10001]) await rejected(insert, [code(), bps, 0, null, staffId]);
    await rejected(insert, [code(), 1000, -1, null, staffId]);
    await rejected(insert, [code(), 1000, 0, 0, staffId]);
    const row = await coupon({ usageLimit: 2 });
    await rejected(insert, [row.code, 500, 0, null, staffId], "23505");
    await rejected("UPDATE coupons SET code='RENAMED' WHERE id=$1", [row.id]);
    await rejected("UPDATE coupons SET version=0 WHERE id=$1", [row.id]);
    await rejected(
      "UPDATE coupons SET starts_at='2026-01-02', expires_at='2026-01-01' WHERE id=$1",
      [row.id],
    );
    // The use count cannot be written directly, at creation or later.
    await rejected("UPDATE coupons SET active_redemptions=1 WHERE id=$1", [row.id], "42501");
    await rejected(
      "INSERT INTO coupons (code,percent_bps,active_redemptions,updated_by) VALUES ($1,1000,3,$2)",
      [code(), staffId],
      "42501",
    );
    expect(row).toMatchObject({ active: true, activeRedemptions: 0, version: 1 });
    expect(row.id.split("-")[2]![0]).toBe("7");
  });
  it("accepts one typed code in any case and gives the half-up discount", async () => {
    const row = await coupon({ percentBps: 1500 });
    for (const typed of [row.code, row.code.toLowerCase(), `  ${row.code} `])
      expect(await previewCoupon(db, typed, 21999)).toEqual({
        couponId: row.id,
        code: row.code,
        percentBps: 1500,
        version: 1,
        merchandiseSubtotalFils: 21999,
        discountFils: 3300,
      });
    // A preview records nothing.
    expect(await uses(row.id)).toBe(0);
  });
  it("rejects with the right reason and store code", async () => {
    expect(await reason(previewCoupon(db, "NOSUCHCODE", 1000))).toBe("UNKNOWN");
    for (const malformed of ["", "a b", "x".repeat(200), "A,B"])
      expect(await reason(previewCoupon(db, malformed, 1000))).toBe("UNKNOWN");
    expect(await reason(previewCoupon(db, (await coupon({ active: false })).code, 1000))).toBe(
      "INACTIVE",
    );
    const future = await coupon({ startsAt: new Date(Date.now() + 3_600_000) });
    expect(await reason(previewCoupon(db, future.code, 1000))).toBe("NOT_STARTED");
    const past = await coupon({ expiresAt: new Date(Date.now() - 1000) });
    expect(await reason(previewCoupon(db, past.code, 1000))).toBe("EXPIRED");
    const minimum = await coupon({ minSubtotalFils: 10000n });
    expect(await reason(previewCoupon(db, minimum.code, 9999))).toBe("MINIMUM_NOT_MET");
    expect((await previewCoupon(db, minimum.code, 10000)).discountFils).toBe(1000);
    const full = await coupon({ usageLimit: 1 });
    await order(full.code, 5000);
    const error = await previewCoupon(db, full.code, 5000).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ reason: "LIMIT_REACHED", code: "COUPON_LIMIT_REACHED" });
    expect(
      await previewCoupon(db, "NOSUCHCODE", 1).catch((thrown: unknown) => thrown),
    ).toMatchObject({ code: "COUPON_INVALID", message: "Coupon rejected" });
  });
  it("uses the database clock for expiry", async () => {
    const row = await coupon();
    // Expired by the database's clock, whatever this process believes the time is.
    await pool.query(
      "UPDATE coupons SET expires_at=statement_timestamp()-interval '1 millisecond', starts_at=NULL WHERE id=$1",
      [row.id],
    );
    expect(await reason(previewCoupon(db, row.code, 1000))).toBe("EXPIRED");
    expect(await reason(order(row.code, 1000))).toBe("EXPIRED");
  });
  it("records a use with its snapshot and allows one redemption per order", async () => {
    const row = await coupon({ percentBps: 2500 });
    const { orderId, applied } = await order(row.code, 12999);
    expect(applied.discountFils).toBe(3250);
    expect(await db.couponRedemption.findUniqueOrThrow({ where: { orderId } })).toMatchObject({
      couponId: row.id,
      code: row.code,
      percentBps: 2500,
      merchandiseSubtotalFils: 12999n,
      discountFils: 3250n,
      releasedAt: null,
    });
    expect(await uses(row.id)).toBe(1);
    // No stacking: the same order cannot redeem again, with this or another coupon.
    const other = await coupon();
    await expect(order(row.code, 12999, orderId)).rejects.toMatchObject({ code: "P2002" });
    await expect(order(other.code, 12999, orderId)).rejects.toMatchObject({ code: "P2002" });
    expect(await uses(row.id)).toBe(1);
    expect(await uses(other.id)).toBe(0);
    // Later edits of the coupon do not change what the order recorded.
    await pool.query("UPDATE coupons SET percent_bps=100, version=version+1 WHERE id=$1", [row.id]);
    expect((await db.couponRedemption.findUniqueOrThrow({ where: { orderId } })).percentBps).toBe(
      2500,
    );
    await rejected("UPDATE coupon_redemptions SET discount_fils=1 WHERE order_id=$1", [orderId]);
    await rejected(
      "INSERT INTO coupon_redemptions (coupon_id,order_id,code,percent_bps,merchandise_subtotal_fils,discount_fils) VALUES ($1,$2,$3,1000,100,101)",
      [row.id, randomUUID(), row.code],
    );
  });
  it("lets exactly the limit through when orders race for the last uses", async () => {
    const row = await coupon({ usageLimit: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => order(row.code, 5000)),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(3);
    expect(lost).toHaveLength(5);
    for (const result of lost)
      expect((result as PromiseRejectedResult).reason).toMatchObject({ reason: "LIMIT_REACHED" });
    expect(await uses(row.id)).toBe(3);
    expect(await db.couponRedemption.count({ where: { couponId: row.id } })).toBe(3);
    // Even a caller that skips the eligibility check cannot exceed the limit.
    await rejected(
      "INSERT INTO coupon_redemptions (coupon_id,order_id,code,percent_bps,merchandise_subtotal_fils,discount_fils) VALUES ($1,$2,$3,1000,5000,500)",
      [row.id, await anOrder(), row.code],
    );
    expect(await uses(row.id)).toBe(3);
  });
  it("gives a use back exactly once and lets the next order take it", async () => {
    const row = await coupon({ usageLimit: 1 });
    const { orderId } = await order(row.code, 5000);
    expect(await reason(order(row.code, 5000))).toBe("LIMIT_REACHED");
    const released = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction(db, async (tx) => {
          // A cancellation locks its order first; the release follows under that lock.
          await lockOrder(tx, orderId);
          return releaseCouponRedemption(tx, orderId);
        }),
      ),
    );
    expect(released.filter(Boolean)).toHaveLength(1);
    expect(await uses(row.id)).toBe(0);
    const kept = await db.couponRedemption.findUniqueOrThrow({ where: { orderId } });
    expect(kept.releasedAt).toBeInstanceOf(Date);
    // History stays: the row is still there, and cannot be released or revived again.
    await rejected("UPDATE coupon_redemptions SET released_at=NULL WHERE order_id=$1", [orderId]);
    await rejected(
      "UPDATE coupon_redemptions SET released_at=statement_timestamp() WHERE order_id=$1",
      [orderId],
    );
    // An order that used no coupon has nothing to release.
    const plain = await anOrder();
    expect(
      await withTransaction(db, async (tx) => {
        await lockOrder(tx, plain);
        return releaseCouponRedemption(tx, plain);
      }),
    ).toBe(false);
    // Without the order lock a release is refused outright.
    await expect(withTransaction(db, (tx) => releaseCouponRedemption(tx, orderId))).rejects.toThrow(
      "after locking its order",
    );
    await order(row.code, 5000);
    expect(await uses(row.id)).toBe(1);
    // The cancelled order cannot take the coupon a second time.
    await expect(order(row.code, 5000, orderId)).rejects.toThrow();
    expect(await couponCountMismatches(db)).toEqual([]);
  });
  it("refuses a redemption for an order that does not exist", async () => {
    const row = await coupon();
    await expect(
      withTransaction(db, async (tx) =>
        redeemCoupon(tx, randomUUID(), await lockCouponForOrder(tx, row.code, 5000)),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await uses(row.id)).toBe(0);
  });
  it("rolls the use back with the order and needs a unit of work", async () => {
    const row = await coupon({ usageLimit: 1 });
    const seeded = await anOrder();
    await expect(
      withTransaction(db, async (tx) => {
        const applied = await lockCouponForOrder(tx, row.code, 5000);
        await redeemCoupon(tx, seeded, applied);
        throw new Error("synthetic order failure");
      }),
    ).rejects.toThrow("synthetic order failure");
    expect(await uses(row.id)).toBe(0);
    expect(await db.couponRedemption.count({ where: { couponId: row.id } })).toBe(0);
    // Only what was decided under the lock, in the same transaction, can be recorded.
    const previewed = await previewCoupon(db, row.code, 5000);
    await expect(
      withTransaction(db, (tx) => redeemCoupon(tx, randomUUID(), previewed)),
    ).rejects.toThrow("locked in this unit of work");
    await expect(
      withTransaction(db, async (tx) => {
        const applied = await lockCouponForOrder(tx, row.code, 5000);
        return redeemCoupon(tx, randomUUID(), { ...applied, discountFils: 5000 });
      }),
    ).rejects.toThrow("locked in this unit of work");
    const stale = await withTransaction(db, (tx) => lockCouponForOrder(tx, row.code, 5000));
    await expect(
      withTransaction(db, (tx) => redeemCoupon(tx, randomUUID(), stale)),
    ).rejects.toThrow("locked in this unit of work");
    expect(await uses(row.id)).toBe(0);
    await expect(lockCouponForOrder(db as never, row.code, 5000)).rejects.toThrow("unit of work");
    await expect(releaseCouponRedemption(db as never, randomUUID())).rejects.toThrow(
      "unit of work",
    );
  });
  it("holds the coupon against an Owner edit until the order commits", async () => {
    const row = await coupon();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const running = withTransaction(db, async (tx) => {
      const applied = await lockCouponForOrder(tx, row.code, 10000);
      entered();
      await gate;
      return applied;
    });
    await inside;
    const edit = pool.query("UPDATE coupons SET active=false, version=version+1 WHERE id=$1", [
      row.id,
    ]);
    const done = await Promise.race([
      edit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(done).toBe(false);
    release();
    expect((await running).discountFils).toBe(1000);
    await edit;
    expect(await reason(order(row.code, 10000))).toBe("INACTIVE");
  });
  it("lets the runtime role edit terms and release, never the count, identity or history", async () => {
    if (!runtimeRole) return;
    const check = async (sql: string) =>
      (await pool.query<{ ok: boolean }>(sql, [namespace])).rows[0]!.ok;
    const table = (name: string, privilege: string) =>
      check(`SELECT has_table_privilege('ih_app', $1 || '.${name}', '${privilege}') AS ok`);
    const column = (name: string, col: string) =>
      check(`SELECT has_column_privilege('ih_app', $1 || '.${name}', '${col}', 'UPDATE') AS ok`);
    for (const name of ["coupons", "coupon_redemptions"]) {
      expect(await table(name, "SELECT")).toBe(true);
      expect(await table(name, "INSERT")).toBe(true);
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
        expect(await table(name, privilege)).toBe(false);
    }
    for (const col of ["percent_bps", "active", "usage_limit", "expires_at", "version"])
      expect(await column("coupons", col)).toBe(true);
    for (const col of ["active_redemptions", "code", "id", "created_at"])
      expect(await column("coupons", col)).toBe(false);
    expect(await column("coupon_redemptions", "released_at")).toBe(true);
    for (const col of ["discount_fils", "percent_bps", "order_id", "coupon_id", "redeemed_at"])
      expect(await column("coupon_redemptions", col)).toBe(false);
    // The whole order path works as the runtime role, through the definer trigger.
    const row = await coupon({ usageLimit: 1 });
    const orderId = await anOrder();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE ih_app");
      } catch (error) {
        // Locally ih_test may not be a member of ih_app; CI (superuser) always exercises this.
        if (process.env.CI) throw error;
        await client.query("ROLLBACK");
        return;
      }
      const table = (name: string) => `"${namespace}".${name}`;
      await client.query(`SELECT id FROM ${table("coupons")} WHERE id=$1 FOR UPDATE`, [row.id]);
      await client.query(
        `INSERT INTO ${table("coupon_redemptions")} (coupon_id,order_id,code,percent_bps,merchandise_subtotal_fils,discount_fils) VALUES ($1,$2,$3,1000,5000,500)`,
        [row.id, orderId, row.code],
      );
      await client.query("SAVEPOINT direct");
      await expect(
        client.query(`UPDATE ${table("coupons")} SET active_redemptions=0 WHERE id=$1`, [row.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT direct");
      await client.query(
        `UPDATE ${table("coupon_redemptions")} SET released_at=statement_timestamp() WHERE order_id=$1`,
        [orderId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await uses(row.id)).toBe(0);
    expect(await couponCountMismatches(db)).toEqual([]);
  });
});
