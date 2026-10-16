import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { adminDashboardSchema } from "@ih/contracts";
import { createDatabase, createPool, rollupDay } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { dubaiDate } from "@ih/domain";
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
  applicationName: "ih-admin-dashboard-test",
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
let staffRoleId = "";
let host = 10;
let delayedOrder = "";
let lowVariant = "";

const dashboard = async (cookie: string) => {
  const response = await fetch(`${base}/v1/admin/dashboard`, {
    headers: { cookie, "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}` },
  });
  return response;
};
const read = async (cookie: string) => {
  const response = await dashboard(cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return adminDashboardSchema.parse(await response.json());
};
const setPermission = (key: string, enabled: boolean) =>
  pool.query(
    enabled
      ? "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING"
      : "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2",
    [staffRoleId, key],
  );

describe("admin operational dashboard through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      await db.staffUser.create({
        data: {
          email,
          name: "Desk " + key,
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
      return { roleId: role.id, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    owner = (await login("owner", "desk-owner@iqoshaven.test")).cookie;
    const s = await login("staff", "desk-staff@iqoshaven.test");
    staff = s.cookie;
    staffRoleId = s.roleId;

    // Three open orders: one pending placed three hours ago (delayed), one fresh pending, one
    // confirmed. Each seeded order has its own published variant (stock 0 = out of stock).
    const late = await seedOrder(pool);
    delayedOrder = late.orderId;
    await pool.query(
      `ALTER TABLE orders DISABLE TRIGGER USER;
       UPDATE orders SET created_at = now() - interval '3 hours' WHERE id = '${late.orderId}';
       ALTER TABLE orders ENABLE TRIGGER USER;`,
    );
    await seedOrder(pool);
    const confirmed = await seedOrder(pool, { status: "confirmed", quantity: 2 });
    lowVariant = confirmed.variantId;
    await pool.query(
      "UPDATE products SET status='published' WHERE id IN (SELECT product_id FROM variants)",
    );
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses a request without a session", async () => {
    expect((await fetch(`${base}/v1/admin/dashboard`)).status).toBe(401);
  });

  it("gives Staff the operational picture and no money beyond order totals", async () => {
    const view = await read(staff);
    expect(view.timezone).toBe("Asia/Dubai");
    expect(view.orders!.open).toEqual({
      pending: 2,
      confirmed: 1,
      processing: 0,
      outForDelivery: 0,
    });
    expect(view.orders!.delayed).toBe(1);
    expect(view.orders!.placedToday + view.orders!.placedYesterdaySoFar).toBeGreaterThanOrEqual(2);
    // Oldest first: the delayed order leads the attention list.
    expect(view.orders!.attention[0]).toMatchObject({ id: delayedOrder, delayed: true });
    expect(view.orders!.attention.map((line) => line.status)).not.toContain("confirmed");
    expect(view.orders!.recent).toHaveLength(3);
    // Staff holds customers.read: the name, never the phone or address.
    expect(view.orders!.recent[0]!.customerName).toBe("Seed Customer");
    expect(JSON.stringify(view)).not.toMatch(/\+971|phone|building/i);
    expect(view.stock!.out).toBeGreaterThanOrEqual(1);
    expect(view.stock!.items.map((item) => item.variantId)).toContain(lowVariant);
    // No moderation right, no financial right.
    expect(view.reviews).toBeNull();
    expect(view.sales).toBeNull();
    await rollupDay(db, dubaiDate(new Date()), ["products"]);
    const top = (await read(staff)).topProducts!;
    expect(top.items.reduce((sum, item) => sum + item.units, 0)).toBe(4);
    expect(top.items.every((item) => item.netFils === null)).toBe(true);
  });

  it("drops a section as soon as the right behind it is withdrawn", async () => {
    await setPermission("customers.read", false);
    expect((await read(staff)).orders!.recent.every((line) => line.customerName === null)).toBe(
      true,
    );
    await setPermission("orders.read", false);
    await setPermission("inventory.read", false);
    const bare = await read(staff);
    expect(bare.orders).toBeNull();
    expect(bare.topProducts).toBeNull();
    expect(bare.stock).toBeNull();
    for (const key of ["customers.read", "orders.read", "inventory.read"])
      await setPermission(key, true);
    expect((await read(staff)).orders).not.toBeNull();
  });

  it("gives the Owner the day figures with their freshness, and none before they exist", async () => {
    const today = dubaiDate(new Date());
    await pool.query("DELETE FROM sales_daily");
    const before = await read(owner);
    // The Owner moderates reviews: the count is there, zero here.
    expect(before.reviews).toEqual({ pending: 0 });
    expect(before.sales).toMatchObject({ currency: "AED", today: null, yesterday: null });
    await rollupDay(db, today);
    const after = (await read(owner)).sales!;
    // 6500 + 6500 + 11500 placed today, all booked.
    expect(after.today).toMatchObject({
      day: today,
      orders: 3,
      totalFils: 24_500,
      aovFils: 8167,
      cancelledOrders: 0,
    });
    expect(Date.parse(after.today!.computedAt)).toBeLessThanOrEqual(Date.now());
    expect(after.taxNote).toMatch(/no separate VAT/);
    const top = (await read(owner)).topProducts!;
    expect(top.items.every((item) => typeof item.netFils === "number")).toBe(true);
  });

  it("refuses a deactivated account", async () => {
    await pool.query(
      "UPDATE staff_users SET active=false, version=version+1 WHERE email='desk-staff@iqoshaven.test'",
    );
    expect([401, 403]).toContain((await dashboard(staff)).status);
  });
});
