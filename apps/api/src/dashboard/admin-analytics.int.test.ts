import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { analyticsSchema } from "@ih/contracts";
import { createDatabase, createPool, readFinancialSummary, rollupDay } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { addDays, dubaiDate } from "@ih/domain";
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
  applicationName: "ih-admin-analytics-test",
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
let ownerId = "";
let staff = "";
let host = 10;
let productB = "";
const today = () => dubaiDate(new Date());
const get = (query: string, cookie: string) =>
  fetch(`${base}/v1/admin/analytics${query}`, {
    headers: { cookie, "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}` },
  });
const read = async (from: string, to: string) => {
  const response = await get(`?from=${from}&to=${to}`, owner);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return analyticsSchema.parse(await response.json());
};
const event = (type: string, payload: object) =>
  pool.query("INSERT INTO events (id, type, payload) VALUES ($1, $2, $3)", [
    randomUUID(),
    type,
    JSON.stringify(payload),
  ]);

describe("owner analytics through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: "An " + key,
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
      return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login("owner", "an-owner@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = (await login("staff", "an-staff@iqoshaven.test")).cookie;
    await seedOrder(pool); // pending, 5000 + 1500
    const b = await seedOrder(pool, { status: "confirmed", quantity: 2 }); // 10000 + 1500
    productB = (await db.orderItem.findFirstOrThrow({ where: { orderId: b.orderId } })).productId;
    await event("search", { term: "grape", resultCount: 3 });
    await event("search", { term: "mango ice", resultCount: 0 });
    await event("search", { term: "mango ice", resultCount: 0 });
    await event("search", { term: null, resultCount: 2 });
    await event("wishlist_add", { productId: productB });
    await event("wishlist_add", { productId: productB });
    await event("wishlist_remove", { productId: productB });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("is the Owner's: no session 401, Staff 403, impossible or over-long range 400", async () => {
    expect((await fetch(`${base}/v1/admin/analytics?from=${today()}&to=${today()}`)).status).toBe(
      401,
    );
    expect((await get(`?from=${today()}&to=${today()}`, staff)).status).toBe(403);
    expect((await get("?from=2026-02-30&to=2026-03-01", owner)).status).toBe(400);
    expect((await get("?from=2024-01-01&to=2026-01-01", owner)).status).toBe(400);
    expect((await get(`?from=${today()}`, owner)).status).toBe(400);
    expect((await get(`?from=${today()}&to=${today()}&extra=1`, owner)).status).toBe(400);
  });

  it("names the days not computed instead of counting them as zero", async () => {
    const view = await read(addDays(today(), -2), today());
    expect(view.freshness).toMatchObject({ computedDays: 0, oldestComputedAt: null });
    expect(view.freshness.missing).toHaveLength(3);
    expect(view.days).toEqual([]);
    expect(view.totals.booked.orders).toBe(0);
    // The status mix is live: the two orders placed today are there already.
    expect(view.statusMix.pending + view.statusMix.confirmed).toBe(2);
  });

  it("matches the live summary once computed, with products, brands, search and saves", async () => {
    await rollupDay(db, today());
    const view = await read(today(), today());
    const live = await readFinancialSummary(db, ownerId, { from: today(), to: today() });
    expect(view.freshness).toMatchObject({ computedDays: 1, missing: [] });
    expect(view.totals.booked).toEqual(live.booked.active);
    expect(view.totals.delivered.orders).toBe(live.delivered.orders);
    expect(view.totals).toMatchObject({ placed: 2, cancelled: { orders: 0, rateBps: 0 } });
    expect(view.totals.booked).toMatchObject({ orders: 2, totalFils: 18_000, aovFils: 9000 });
    expect(view.days).toEqual([
      expect.objectContaining({ day: today(), placed: 2, bookedTotalFils: 18_000 }),
    ]);
    // The previous period is the day before: not computed.
    expect(view.previous).toMatchObject({
      from: addDays(today(), -1),
      to: addDays(today(), -1),
      missingDays: 1,
      bookedOrders: 0,
      aovFils: null,
    });
    // Nothing delivered yet: ranked by ordered units, shares not defined.
    expect(view.products[0]).toMatchObject({
      productId: productB,
      orderedUnits: 2,
      shareBps: null,
    });
    expect(view.brands.reduce((sum, row) => sum + row.orderedUnits, 0)).toBe(3);
    expect(view.search).toMatchObject({
      searches: 4,
      zeroResults: 2,
      zeroRateBps: 5000,
      notKept: 1,
      zeroTerms: [{ term: "mango ice", searches: 2 }],
    });
    expect(view.search.terms.map((row) => row.term)).toEqual(["mango ice", "grape"]);
    expect(view.wishlist).toMatchObject({
      adds: 2,
      removes: 1,
      products: [expect.objectContaining({ productId: productB, adds: 2, outOfStock: true })],
    });
  });
});
