import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { adminOrderResponseSchema, adminOrdersResponseSchema } from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
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
  applicationName: "ih-admin-orders-test",
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
let staffCookie = "";
let staffRoleId = "";
let first: Awaited<ReturnType<typeof seedOrder>>;
let second: Awaited<ReturnType<typeof seedOrder>>;

async function setStaffPermission(key: "orders.read" | "customers.read", enabled: boolean) {
  if (enabled)
    await pool.query(
      `INSERT INTO role_permissions (role_id,permission_id)
       SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING`,
      [staffRoleId, key],
    );
  else
    await pool.query(
      `DELETE FROM role_permissions rp USING permissions p
       WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2`,
      [staffRoleId, key],
    );
}
const call = (path: string, cookie = staffCookie) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    headers: { cookie, "x-ih-client-ip": "192.0.2.83" },
  });

describe("admin order list and snapshot detail through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    staffRoleId = role.id;
    const staff = await db.staffUser.create({
      data: {
        email: "orders-reader@iqoshaven.test",
        name: "Order Reader",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    first = await seedOrder(pool, { quantity: 2 });
    second = await seedOrder(pool, { status: "confirmed" });
    await db.customer.update({
      where: { id: first.customerId },
      data: { displayName: "Changed customer record" },
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: {
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": "192.0.2.82",
      },
      body: JSON.stringify({ email: staff.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    staffCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("requires a current orders.read grant and refuses invalid bounds and cursors", async () => {
    expect((await call("", "")).status).toBe(401);
    await setStaffPermission("orders.read", false);
    try {
      expect((await call("")).status).toBe(403);
    } finally {
      await setStaffPermission("orders.read", true);
    }
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?status=unknown",
      "?q=%20%20",
      "?after=abc",
      "?from=2026-10-13T12:00:00.000Z&to=2026-10-13T12:00:00.000Z",
      "?extra=yes",
    ])
      expect((await call(query)).status, query).toBe(400);
    expect((await call("/not-a-uuid")).status).toBe(400);
    expect((await call("/" + randomUUID())).status).toBe(404);
  });

  it("filters and keyset-pages newest-first within bounded dates", async () => {
    const firstPageResponse = await call("?limit=1");
    expect(firstPageResponse.status).toBe(200);
    expect(firstPageResponse.headers.get("cache-control")).toBe("private, no-store");
    const page = adminOrdersResponseSchema.parse(await firstPageResponse.json());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = adminOrdersResponseSchema.parse(
      await (await call("?limit=1&after=" + page.nextCursor)).json(),
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    const confirmed = adminOrdersResponseSchema.parse(
      await (
        await call("?status=confirmed&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z")
      ).json(),
    );
    expect(confirmed.items.map((item) => item.id)).toEqual([second.orderId]);
    expect(confirmed.items[0]).toMatchObject({ itemCount: 1, customer: { name: "Seed Customer" } });
  });

  it("returns immutable customer, address, item, amount and append-only history snapshots", async () => {
    const byNumber = adminOrdersResponseSchema.parse(
      await (await call("?q=" + first.orderNumber)).json(),
    );
    expect(byNumber.items.map((item) => item.id)).toEqual([first.orderId]);
    const byCustomer = adminOrdersResponseSchema.parse(
      await (await call("?q=Seed%20Customer")).json(),
    );
    expect(byCustomer.items.map((item) => item.id)).toContain(first.orderId);
    const detailResponse = await call("/" + first.orderId);
    expect(detailResponse.status).toBe(200);
    const detail = adminOrderResponseSchema.parse(await detailResponse.json());
    expect(detail).toMatchObject({
      customer: {
        name: "Seed Customer",
        address: { building: "Seed Villa 1" },
      },
      merchandiseSubtotalFils: 10000,
      deliveryFeeFils: 1500,
      totalFils: 11500,
      items: [{ productName: "Seed product", quantity: 2, attributes: {} }],
      history: [{ fromStatus: null, toStatus: "pending", actorKind: "customer", orderVersion: 1 }],
    });
    expect(JSON.stringify(detail)).not.toContain("Changed customer record");
    for (const secret of [
      "customerId",
      "creationKeyHash",
      "quoteFingerprint",
      "confirmationHash",
      "commandId",
    ])
      expect(detail).not.toHaveProperty(secret);
  });

  it("strips contact and prevents contact-search inference without customers.read", async () => {
    await setStaffPermission("customers.read", false);
    try {
      const list = adminOrdersResponseSchema.parse(await (await call("?q=Seed%20Customer")).json());
      expect(list.items).toEqual([]);
      const number = adminOrdersResponseSchema.parse(
        await (await call("?q=" + first.orderNumber)).json(),
      );
      expect(number.items).toHaveLength(1);
      expect(number.items[0]).not.toHaveProperty("customer");
      const detail = adminOrderResponseSchema.parse(await (await call("/" + first.orderId)).json());
      expect(detail).not.toHaveProperty("customer");
      expect(JSON.stringify(detail)).not.toContain("Seed Customer");
      expect(JSON.stringify(detail)).not.toContain("Seed Villa 1");
    } finally {
      await setStaffPermission("customers.read", true);
    }
  });
});
