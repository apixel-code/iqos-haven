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
  errorEnvelopeSchema,
  manualOrderResponseSchema,
  storeQuoteResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool, stockReconciliationMismatches } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
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
  applicationName: "ih-manual-orders-test",
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

const send = (
  path: string,
  method: string,
  body: unknown,
  cookie: string,
  extra: Record<string, string> = {},
) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin: ADMIN,
      "content-type": "application/json",
      // Each call from its own address keeps the per-address limiter out of the way.
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
      ...extra,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const stockOf = async (variantId: string) =>
  (await one<{ s: number }>("SELECT stock_on_hand AS s FROM variants WHERE id=$1", [variantId])).s;
const count = async (sql: string, params: unknown[]) =>
  Number((await one<{ n: string }>(sql, params)).n);

let areaId = "";
let serial = 0;
const key = () => "m" + randomUUID().replaceAll("-", "");
async function variant(priceFils: bigint, stock: number) {
  const brand = await db.brand.create({
    data: { name: "Desk brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Desk category " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: "Desk Kit",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils: priceFils,
      status: "published",
    },
  });
  const row = await db.variant.create({
    data: {
      productId: product.id,
      sku: key().slice(0, 20).toUpperCase(),
      active: true,
      isDefault: true,
    },
  });
  await pool.query(
    "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
    [row.id, stock, randomUUID()],
  );
  return { id: row.id, productId: product.id };
}
const setPermission = async (key: string, enabled: boolean) =>
  pool.query(
    enabled
      ? "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING"
      : "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2",
    [staffRoleId, key],
  );
const orders = () => count("SELECT count(*) AS n FROM orders", []);

describe("manual orders through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "Desk Owner" : "Desk Staff",
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
    const o = await login("owner", "desk-owner@iqoshaven.test");
    const s = await login("staff", "desk-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "desk_area",
          name: "Desk Area",
          emirate: "dubai",
          active: true,
          updatedBy: ownerId,
        },
      })
    ).id;
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

  /** What the order desk does: price the order, then create it with that total's token. */
  async function manual(
    lines: Array<{ variantId: string; quantity: number }>,
    extra: Record<string, unknown> = {},
    cookie = staff,
  ) {
    const priced = await send("/quote", "POST", { lines, areaId, couponCode: null }, cookie);
    expect(priced.status).toBe(200);
    const quote = storeQuoteResponseSchema.parse(await priced.json());
    return {
      quote,
      body: {
        contact: { name: "Desk Customer", phone: "050 640 " + String(++serial).padStart(4, "0") },
        address: { areaId, type: "villa", building: "Desk Villa 3" },
        lines,
        couponCode: null,
        quoteToken: quote.quote.token,
        ageConfirmed: true,
        start: "pending",
        ...extra,
      },
    };
  }
  const create = (body: unknown, attempt: string | null = key(), cookie = staff) =>
    send("", "POST", body, cookie, attempt === null ? {} : { "idempotency-key": attempt });

  it("lists the delivery choices and prices an order like the storefront does", async () => {
    const choices = await send("/delivery-areas", "GET", null, staff);
    expect(choices.status).toBe(200);
    expect((await choices.json()) as unknown).toMatchObject({
      feeFils: 1500,
      areas: [{ id: areaId, name: "Desk Area", emirate: "dubai" }],
    });
    const item = await variant(4000n, 5);
    const { quote } = await manual([{ variantId: item.id, quantity: 2 }]);
    expect(quote.totalFils).toBe(9500);
  });

  it("creates a Pending order once per attempt key, with the same stock and money rules", async () => {
    const item = await variant(4000n, 5);
    const { body } = await manual([{ variantId: item.id, quantity: 2 }]);
    const attempt = key();
    const first = await create(body, attempt);
    expect(first.status).toBe(201);
    const placed = manualOrderResponseSchema.parse(await first.json());
    expect(placed).toMatchObject({ status: "pending", totalFils: 9500, replayed: false });
    const row = await one<{
      source: string;
      created_by: string;
      status: string;
      age_policy_version: string;
    }>("SELECT source, created_by, status, age_policy_version FROM orders WHERE id=$1", [
      placed.orderId,
    ]);
    expect(row).toMatchObject({ source: "manual", status: "pending" });
    expect(row.created_by).not.toBeNull();
    const history = await one<{ actor_kind: string; to_status: string; reason: string | null }>(
      "SELECT actor_kind, to_status, reason FROM order_status_history WHERE order_id=$1",
      [placed.orderId],
    );
    expect(history).toEqual({ actor_kind: "staff", to_status: "pending", reason: null });
    expect(await stockOf(item.id)).toBe(3);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.created'",
        [placed.orderId],
      ),
    ).toBe(1);
    // A retry is the same order; a changed request with that key is refused.
    const again = await create(body, attempt);
    expect(manualOrderResponseSchema.parse(await again.json())).toEqual({
      ...placed,
      replayed: true,
    });
    expect(
      await errorCode(
        await create({ ...body, lines: [{ variantId: item.id, quantity: 1 }] }, attempt),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(await stockOf(item.id)).toBe(3);
    // The key belongs to the staff member: the same key from someone else is their own attempt.
    const priced = await manual([{ variantId: item.id, quantity: 1 }], {}, owner);
    expect((await create(priced.body, attempt, owner)).status).toBe(201);
    expect(await stockOf(item.id)).toBe(2);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("starts Confirmed only with evidence and the right to confirm", async () => {
    const item = await variant(3000n, 10);
    const evidence = { channel: "phone", note: "Called back on the number given" };
    const { body } = await manual([{ variantId: item.id, quantity: 1 }], {
      start: "confirmed",
      evidence,
    });
    const before = await orders();
    // Confirmed without evidence, or Pending with evidence, is refused.
    expect((await create({ ...body, evidence: undefined })).status).toBe(400);
    expect((await create({ ...body, start: "pending" })).status).toBe(400);
    expect((await create({ ...body, evidence: { channel: "email", note: "x" } })).status).toBe(400);
    // Without the right to confirm, a Confirmed start is refused and nothing is written.
    await setPermission("orders.transition", false);
    try {
      expect((await create(body)).status).toBe(403);
    } finally {
      await setPermission("orders.transition", true);
    }
    expect(await orders()).toBe(before);
    const response = await create(body);
    expect(response.status).toBe(201);
    const placed = manualOrderResponseSchema.parse(await response.json());
    expect(placed.status).toBe("confirmed");
    expect(
      await one<{ to_status: string; reason: string }>(
        "SELECT to_status, reason FROM order_status_history WHERE order_id=$1",
        [placed.orderId],
      ),
    ).toEqual({
      to_status: "confirmed",
      reason: "Confirmed by phone call: Called back on the number given",
    });
    // From Confirmed it carries on through the normal transitions.
    const next = await send(
      `/${placed.orderId}/transitions`,
      "POST",
      { to: "processing", expectedVersion: 1, commandId: randomUUID() },
      staff,
    );
    expect(next.status).toBe(200);
  });

  it("refuses without the right, without a key, without the 18+ attestation or with a client price", async () => {
    const item = await variant(3000n, 10);
    const { body } = await manual([{ variantId: item.id, quantity: 1 }]);
    const before = await orders();
    await setPermission("orders.create", false);
    try {
      expect((await create(body)).status).toBe(403);
      expect(
        (await send("/quote", "POST", { lines: body.lines, areaId, couponCode: null }, staff))
          .status,
      ).toBe(403);
    } finally {
      await setPermission("orders.create", true);
    }
    expect((await create(body, null)).status).toBe(400);
    expect((await create(body, "short")).status).toBe(400);
    expect((await create({ ...body, ageConfirmed: false })).status).toBe(400);
    expect((await create({ ...body, totalFils: 1 })).status).toBe(400);
    expect(
      (
        await send("", "POST", body, staff, {
          origin: "https://evil.example",
          "idempotency-key": key(),
        })
      ).status,
    ).toBe(403);
    expect(await orders()).toBe(before);
  });

  it("refuses a total that moved, more than is in stock, and an area that is not served", async () => {
    const item = await variant(3000n, 2);
    const before = await orders();
    const moving = await manual([{ variantId: item.id, quantity: 1 }]);
    await pool.query("UPDATE products SET base_price_fils=3100, version=version+1 WHERE id=$1", [
      item.productId,
    ]);
    expect(await errorCode(await create(moving.body))).toBe("QUOTE_CHANGED");
    const greedy = await manual([{ variantId: item.id, quantity: 3 }]);
    expect(await errorCode(await create(greedy.body))).toBe("INSUFFICIENT_STOCK");
    const closed = await db.deliveryArea.create({
      data: {
        code: "desk_closed",
        name: "Closed",
        emirate: "dubai",
        active: false,
        updatedBy: ownerId,
      },
    });
    const fresh = await manual([{ variantId: item.id, quantity: 1 }]);
    expect(
      await errorCode(
        await create({ ...fresh.body, address: { ...fresh.body.address, areaId: closed.id } }),
      ),
    ).toBe("AREA_UNAVAILABLE");
    expect(await orders()).toBe(before);
    expect(await stockOf(item.id)).toBe(2);
  });

  it("makes one order from the same attempt sent twice at once, and keeps the attempt's terms", async () => {
    const item = await variant(2500n, 10);
    const { body } = await manual([{ variantId: item.id, quantity: 2 }], {
      start: "confirmed",
      evidence: { channel: "whatsapp", note: "Customer replied YES" },
    });
    const attempt = key();
    const before = await orders();
    const answers = await Promise.all([create(body, attempt), create(body, attempt)]);
    const statuses = answers.map((response) => response.status);
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
    for (const status of statuses) expect([201, 409]).toContain(status);
    expect(await orders()).toBe(before + 1);
    expect(await stockOf(item.id)).toBe(8);
    // The same key with another start or other evidence is a different request.
    for (const changed of [
      { ...body, evidence: { channel: "whatsapp", note: "Something else" } },
      { ...body, start: "pending", evidence: undefined },
    ])
      expect(await errorCode(await create(changed, attempt))).toBe("IDEMPOTENCY_CONFLICT");
    const placed = await one<{ id: string }>(
      "SELECT id FROM orders ORDER BY order_number DESC LIMIT 1",
    );
    // Who created it is on the order, its first history row and its audit entry.
    const [staffRow] = (
      await pool.query("SELECT id FROM staff_users WHERE email='desk-staff@iqoshaven.test'")
    ).rows as Array<{ id: string }>;
    expect(
      await one<{ created_by: string; actor_id: string; audit: string }>(
        `SELECT o.created_by, h.actor_id, a.actor_id AS audit FROM orders o
         JOIN order_status_history h ON h.order_id=o.id
         JOIN audit_log a ON a.entity_id=o.id::text AND a.action='order.created'
         WHERE o.id=$1`,
        [placed.id],
      ),
    ).toEqual({ created_by: staffRow!.id, actor_id: staffRow!.id, audit: staffRow!.id });
  });

  it("applies a coupon through the same rules, and the database refuses a Confirmed start without evidence", async () => {
    const item = await variant(5000n, 10);
    await db.coupon.create({
      data: { code: "DESK10", percentBps: 1000, active: true, updatedBy: ownerId },
    });
    const priced = await send(
      "/quote",
      "POST",
      { lines: [{ variantId: item.id, quantity: 1 }], areaId, couponCode: "desk10" },
      staff,
    );
    const quote = storeQuoteResponseSchema.parse(await priced.json());
    expect(quote.totalFils).toBe(6000);
    const { body } = await manual([{ variantId: item.id, quantity: 1 }]);
    const response = await create({ ...body, couponCode: "desk10", quoteToken: quote.quote.token });
    expect(response.status).toBe(201);
    const placed = manualOrderResponseSchema.parse(await response.json());
    expect(
      await one<{ coupon_code: string; total_fils: string }>(
        "SELECT coupon_code, total_fils FROM orders WHERE id=$1",
        [placed.orderId],
      ),
    ).toEqual({ coupon_code: "DESK10", total_fils: "6000" });
    await expect(
      pool.query(
        "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1, NULL, 'confirmed', 'system', 'x', 1)",
        [placed.orderId],
      ),
    ).rejects.toThrow();
  });
});
