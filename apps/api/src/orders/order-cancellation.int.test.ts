import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import {
  adminOrderResponseSchema,
  errorEnvelopeSchema,
  orderCancelResponseSchema,
} from "@ih/contracts";
import {
  couponCountMismatches,
  createDatabase,
  createPool,
  stockReconciliationMismatches,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-order-cancellation-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
});

let app: INestApplication;
let base = "";
let owner = "";
let staff = "";
let ownerId = "";
let staffRoleId = "";
let host = 10;
type Seeded = Awaited<ReturnType<typeof seedOrder>>;

const send = (path: string, method: string, body: unknown, cookie: string, origin = ADMIN) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      // Each call from its own address keeps the per-address limiter out of the way.
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const cancel = (orderId: string, body: unknown, cookie = staff, origin = ADMIN) =>
  send(`/${orderId}/cancel`, "POST", body, cookie, origin);
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const stockOf = async (variantId: string) =>
  (await one<{ s: number }>("SELECT stock_on_hand AS s FROM variants WHERE id=$1", [variantId])).s;
const order = async (orderId: string) =>
  one<{
    status: string;
    version: number;
    cod: string;
    reason: string | null;
    returned: Date | null;
  }>(
    "SELECT status, version, cod_status AS cod, cancel_reason AS reason, returned_at AS returned FROM orders WHERE id=$1",
    [orderId],
  );
const count = async (sql: string, params: unknown[]) =>
  Number((await one<{ n: string }>(sql, params)).n);
const detail = async (orderId: string) =>
  adminOrderResponseSchema.parse(await (await send(`/${orderId}`, "GET", null, owner)).json());

/** A seeded order whose variant is sellable and holds `stock` units on the ledger. */
async function sellable(seeded: Seeded, stock = 20) {
  for (const sql of [
    `UPDATE brands SET active=true WHERE id=(SELECT p.brand_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    `UPDATE categories SET active=true WHERE id=(SELECT p.category_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    "UPDATE products SET status='published' WHERE id=(SELECT product_id FROM variants WHERE id=$1)",
  ])
    await pool.query(sql, [seeded.variantId]);
  await pool.query(
    "UPDATE delivery_areas SET active=true WHERE id=(SELECT area_id FROM orders WHERE id=$1)",
    [seeded.orderId],
  );
  await pool.query(
    `INSERT INTO stock_movements (variant_id,delta,balance_after,reason,command_id,effect,actor_id)
     VALUES ($1,$2,$2,'INITIAL_STOCK',$3,'adjust',$4)`,
    [seeded.variantId, stock, `stock-${seeded.variantId}`, ownerId],
  );
  return seeded;
}
async function moveTo(orderId: string, targets: string[]) {
  for (const to of targets) {
    const { version } = await order(orderId);
    const response = await send(
      `/${orderId}/transitions`,
      "POST",
      { to, expectedVersion: version, commandId: randomUUID() },
      owner,
    );
    expect(response.status).toBe(200);
  }
}
const command = (expectedVersion: number, extra: Record<string, unknown> = {}) => ({
  expectedVersion,
  commandId: randomUUID(),
  reason: "Customer asked to cancel",
  ...extra,
});

describe("order cancellation through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "Cancel Owner" : "Cancel Staff",
          roleId: role.id,
          passwordHash: await hasher.hash(PASSWORD),
        },
      });
      const response = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: {
          origin: ADMIN,
          "content-type": "application/json",
          "x-ih-client-ip": "192.0.2.250",
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(response.status).toBe(200);
      return {
        id: user.id,
        roleId: role.id,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login("owner", "cancel-owner@iqoshaven.test");
    const s = await login("staff", "cancel-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
    await db.setting.create({
      data: {
        key: "delivery",
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
        updatedBy: ownerId,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses without the right, from another origin, without a reason, or for an unknown order", async () => {
    const target = await sellable(await seedOrder(pool));
    await pool.query(
      `DELETE FROM role_permissions rp USING permissions p
       WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='orders.cancel_before_dispatch'`,
      [staffRoleId],
    );
    try {
      expect((await cancel(target.orderId, command(1))).status).toBe(403);
    } finally {
      await pool.query(
        `INSERT INTO role_permissions (role_id,permission_id)
         SELECT $1,id FROM permissions WHERE key='orders.cancel_before_dispatch'`,
        [staffRoleId],
      );
    }
    expect((await cancel(target.orderId, command(1), staff, "https://evil.example")).status).toBe(
      403,
    );
    for (const body of [
      command(1, { reason: "   " }),
      command(1, { reason: undefined }),
      command(1, { reason: "x".repeat(501) }),
      { ...command(1), commandId: "not-a-uuid" },
      command(1, { refundFils: 100 }),
    ])
      expect((await cancel(target.orderId, body)).status).toBe(400);
    // A return list belongs only to an order that came back after handoff.
    const early = await cancel(
      target.orderId,
      command(1, {
        returnItems: [{ variantId: target.variantId, resellableQuantity: 1, damagedQuantity: 0 }],
      }),
    );
    expect(early.status).toBe(400);
    expect((await cancel(randomUUID(), command(1))).status).toBe(404);
    expect(await order(target.orderId)).toMatchObject({ status: "pending", version: 1 });
  });

  it("cancels before handoff once: every unit and the coupon go back, everything is recorded", async () => {
    const target = await sellable(await seedOrder(pool, { quantity: 2 }));
    // A coupon on the order, added by the step-85 edit command.
    await db.coupon.create({
      data: { code: "CANCEL10", percentBps: 1000, active: true, updatedBy: ownerId },
    });
    const edited = await send(
      `/${target.orderId}`,
      "PATCH",
      {
        expectedVersion: 1,
        commandId: randomUUID(),
        couponCode: "cancel10",
      },
      owner,
    );
    expect(edited.status).toBe(200);
    const stock = await stockOf(target.variantId);
    const body = command(2, { reason: "  Customer changed their mind  " });
    const response = await cancel(target.orderId, body);
    expect(response.status).toBe(200);
    const receipt = orderCancelResponseSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      orderId: target.orderId,
      kind: "before_handoff",
      fromStatus: "pending",
      orderVersion: 3,
      reason: "Customer changed their mind",
      restocked: [{ quantity: 2 }],
      damaged: [],
      couponReleased: true,
      replayed: false,
      actor: { name: "Cancel Staff" },
    });
    expect(await stockOf(target.variantId)).toBe(stock + 2);
    expect(await order(target.orderId)).toMatchObject({
      status: "cancelled",
      version: 3,
      cod: "not_collected",
      reason: "Customer changed their mind",
      returned: null,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM coupon_redemptions WHERE order_id=$1 AND released_at IS NULL",
        [target.orderId],
      ),
    ).toBe(0);
    expect(await couponCountMismatches(db)).toEqual([]);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(
      await count(
        "SELECT count(*) AS n FROM order_status_history WHERE order_id=$1 AND to_status='cancelled' AND reason='Customer changed their mind'",
        [target.orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE entity_id=$1 AND action='order.cancelled'",
        [target.orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.cancelled'",
        [target.orderId],
      ),
    ).toBe(1);
    // The audit entry holds counts, never the reason a person typed.
    const audit = await one<{ diff: unknown; reason: string | null }>(
      "SELECT diff, reason FROM audit_log WHERE entity_id=$1 AND action='order.cancelled'",
      [target.orderId],
    );
    expect(JSON.stringify(audit)).not.toContain("changed their mind");

    // The same command again: the same answer, nothing more.
    const again = await cancel(target.orderId, body);
    expect(again.status).toBe(200);
    expect(orderCancelResponseSchema.parse(await again.json())).toEqual({
      ...receipt,
      replayed: true,
    });
    // The same command ID with another reason, or from someone else, is not that command.
    const changed = await cancel(target.orderId, { ...body, reason: "Another reason" });
    expect(await errorCode(changed)).toBe("COMMAND_REUSED");
    expect(await errorCode(await cancel(target.orderId, body, owner))).toBe("COMMAND_REUSED");
    // A new command cannot cancel it again.
    expect(await errorCode(await cancel(target.orderId, command(3)))).toBe("ORDER_NOT_CANCELLABLE");
    expect(await stockOf(target.variantId)).toBe(stock + 2);
    expect(
      await count(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='ORDER_CANCEL'",
        [target.orderId],
      ),
    ).toBe(1);
  });

  it("returns stock exactly once when many cancellations race", async () => {
    const target = await sellable(await seedOrder(pool, { status: "confirmed", quantity: 3 }));
    const stock = await stockOf(target.variantId);
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        cancel(target.orderId, command(1, { reason: `Race ${i}` }), i % 2 ? staff : owner),
      ),
    );
    const statuses = answers.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(5);
    expect(await stockOf(target.variantId)).toBe(stock + 3);
    expect(
      await count(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='ORDER_CANCEL'",
        [target.orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM order_status_history WHERE order_id=$1 AND to_status='cancelled'",
        [target.orderId],
      ),
    ).toBe(1);
  });

  it("returns what an edited order holds now, so no unit is returned twice", async () => {
    const target = await sellable(await seedOrder(pool, { quantity: 2 }), 10);
    const start = await stockOf(target.variantId);
    // The edit takes one more unit through the ledger: the order now holds three.
    const edited = await send(
      `/${target.orderId}`,
      "PATCH",
      {
        expectedVersion: 1,
        commandId: randomUUID(),
        lines: [{ variantId: target.variantId, quantity: 3 }],
      },
      owner,
    );
    expect(edited.status).toBe(200);
    expect(await stockOf(target.variantId)).toBe(start - 1);
    const response = await cancel(target.orderId, command(2));
    expect(orderCancelResponseSchema.parse(await response.json()).restocked).toEqual([
      expect.objectContaining({ quantity: 3 }),
    ]);
    expect(await stockOf(target.variantId)).toBe(start + 2);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("lets staff cancel while processing, but never a delivered order", async () => {
    const processing = await sellable(await seedOrder(pool, { status: "confirmed" }));
    await moveTo(processing.orderId, ["processing"]);
    const response = await cancel(processing.orderId, command(2));
    expect(response.status).toBe(200);
    expect(orderCancelResponseSchema.parse(await response.json()).fromStatus).toBe("processing");

    const delivered = await sellable(await seedOrder(pool, { status: "confirmed" }));
    await moveTo(delivered.orderId, ["processing", "out_for_delivery", "delivered"]);
    const stock = await stockOf(delivered.variantId);
    for (const cookie of [staff, owner])
      expect(await errorCode(await cancel(delivered.orderId, command(4), cookie))).toBe(
        "ORDER_NOT_CANCELLABLE",
      );
    expect(await order(delivered.orderId)).toMatchObject({ status: "delivered", cod: "pending" });
    expect(await stockOf(delivered.variantId)).toBe(stock);
    // A stale version is refused before anything else.
    const stale = await sellable(await seedOrder(pool));
    expect(await errorCode(await cancel(stale.orderId, command(7)))).toBe("VERSION_CONFLICT");
  });

  it("cancels after handoff only as the Owner's classified return, restocking only resellable units", async () => {
    const target = await sellable(await seedOrder(pool, { status: "confirmed", quantity: 3 }));
    await moveTo(target.orderId, ["processing", "out_for_delivery"]);
    const stock = await stockOf(target.variantId);
    const line = (
      resellableQuantity: number,
      damagedQuantity: number,
      variantId = target.variantId,
    ) => ({
      variantId,
      resellableQuantity,
      damagedQuantity,
    });
    // Staff may not cancel once the goods have left.
    expect((await cancel(target.orderId, command(3, { returnItems: [line(3, 0)] }))).status).toBe(
      403,
    );
    // Every line must be classified, completely, and nothing else.
    for (const returnItems of [
      undefined,
      [line(1, 1)],
      [line(3, 1)],
      [line(3, 0), line(1, 0, randomUUID())],
      [line(2, 1), line(2, 1)],
    ])
      expect(
        await errorCode(await cancel(target.orderId, command(3, { returnItems }), owner)),
      ).toBe("RETURN_INCOMPLETE");
    expect(await order(target.orderId)).toMatchObject({ status: "out_for_delivery" });

    const body = command(3, { reason: "Returned by courier", returnItems: [line(2, 1)] });
    const response = await cancel(target.orderId, body, owner);
    expect(response.status).toBe(200);
    const receipt = orderCancelResponseSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      kind: "returned",
      fromStatus: "out_for_delivery",
      restocked: [{ quantity: 2 }],
      damaged: [{ quantity: 1 }],
    });
    expect(await stockOf(target.variantId)).toBe(stock + 2);
    const after = await order(target.orderId);
    expect(after).toMatchObject({ status: "cancelled", cod: "not_collected" });
    expect(after.returned).not.toBeNull();
    expect(
      await count(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='ORDER_RETURN'",
        [target.orderId],
      ),
    ).toBe(1);
    // The admin detail shows how it came back.
    const shown = await detail(target.orderId);
    expect(shown).toMatchObject({
      status: "cancelled",
      cancelReason: "Returned by courier",
      returnItems: [{ quantity: 3, resellableQuantity: 2, damagedQuantity: 1 }],
    });
    // The same return replays; the line order of the list does not matter.
    const again = await cancel(target.orderId, body, owner);
    expect(orderCancelResponseSchema.parse(await again.json())).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(await stockOf(target.variantId)).toBe(stock + 2);
  });

  it("rolls everything back when a late write fails", async () => {
    const target = await sellable(await seedOrder(pool, { quantity: 2 }));
    const stock = await stockOf(target.variantId);
    await pool.query(`CREATE FUNCTION reject_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='order.cancelled' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_cancel_audit()`);
    const body = command(1);
    try {
      expect((await cancel(target.orderId, body)).status).toBe(500);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_cancel_audit ON audit_log; DROP FUNCTION reject_cancel_audit()",
      );
    }
    expect(await order(target.orderId)).toMatchObject({
      status: "pending",
      version: 1,
      cod: "pending",
    });
    expect(await stockOf(target.variantId)).toBe(stock);
    expect(
      await count("SELECT count(*) AS n FROM order_cancellations WHERE order_id=$1", [
        target.orderId,
      ]),
    ).toBe(0);
    // Nothing was kept, so the same command now succeeds.
    expect((await cancel(target.orderId, body)).status).toBe(200);
    expect(await stockOf(target.variantId)).toBe(stock + 2);
  });

  it("keeps the cancellation record and ledger rows unchangeable", async () => {
    const target = await sellable(await seedOrder(pool));
    expect((await cancel(target.orderId, command(1))).status).toBe(200);
    for (const sql of [
      "UPDATE order_cancellations SET kind='returned' WHERE order_id=$1",
      "DELETE FROM order_cancellations WHERE order_id=$1",
      "UPDATE orders SET cancel_reason='Rewritten', version=version+1 WHERE id=$1",
      `INSERT INTO stock_movements (variant_id,delta,balance_after,reason,command_id,effect,order_id)
       SELECT variant_id, 1, 999, 'ORDER_CANCEL', 'cancel:' || order_id, 'order_cancel', order_id
       FROM order_items WHERE order_id=$1`,
    ])
      await expect(pool.query(sql, [target.orderId])).rejects.toThrow();
  });

  it("answers the same command sent twice at once with one cancellation", async () => {
    const target = await sellable(await seedOrder(pool, { quantity: 2 }));
    const stock = await stockOf(target.variantId);
    const body = command(1);
    const answers = await Promise.all([cancel(target.orderId, body), cancel(target.orderId, body)]);
    expect(answers.map((response) => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(
      answers.map(async (response) => orderCancelResponseSchema.parse(await response.json())),
    );
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect({ ...receipts[0], replayed: false }).toEqual({ ...receipts[1], replayed: false });
    expect(await stockOf(target.variantId)).toBe(stock + 2);
  });

  it("records an all-damaged return without putting anything back, and accepts any ID spelling", async () => {
    const target = await sellable(await seedOrder(pool, { status: "confirmed", quantity: 2 }));
    await moveTo(target.orderId, ["processing", "out_for_delivery"]);
    const stock = await stockOf(target.variantId);
    const body = command(3, {
      returnItems: [
        { variantId: target.variantId.toUpperCase(), resellableQuantity: 0, damagedQuantity: 2 },
      ],
    });
    const response = await cancel(target.orderId, body, owner);
    expect(response.status).toBe(200);
    const receipt = orderCancelResponseSchema.parse(await response.json());
    expect(receipt).toMatchObject({ restocked: [], damaged: [{ quantity: 2 }] });
    expect(await stockOf(target.variantId)).toBe(stock);
    expect(
      await count(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='ORDER_RETURN'",
        [target.orderId],
      ),
    ).toBe(0);
    // The lower-case spelling of the same list is the same command.
    const again = await cancel(
      target.orderId,
      {
        ...body,
        returnItems: [{ variantId: target.variantId, resellableQuantity: 0, damagedQuantity: 2 }],
      },
      owner,
    );
    expect(orderCancelResponseSchema.parse(await again.json()).replayed).toBe(true);
  });
});
