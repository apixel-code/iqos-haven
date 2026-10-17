import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { analyticsSchema, reportJobSchema } from "@ih/contracts";
import {
  backfillRollups,
  cancelOrder,
  createDatabase,
  createPool,
  readFinancialSummary,
  recordCollection,
  rollupDay,
  transitionOrder,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { addDays, dubaiDate } from "@ih/domain";
import { Argon2PasswordHasher } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

/**
 * M10 acceptance (roadmap step 114): dashboards, analytics, reports and SEO checked together
 * against one set of real orders. Each module has its own suite; this one checks that they
 * agree with each other across a Dubai midnight, that recomputing never changes a figure, and
 * which fields every role receives from every M10 route.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-m10-acceptance-test",
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
let ownerId = "";
const cookies: Record<string, string> = {};
let host = 10;
/** Day A (five days ago): the delivered order is placed at 23:30 Dubai on A. */
const A = addDays(dubaiDate(new Date()), -5);
const B = addDays(A, 1);
const C = addDays(A, 2);
/** A Dubai wall-clock time as an instant (Dubai is UTC+4, no DST). */
const dubai = (day: string, time: string) => new Date(`${day}T${time}:00+04:00`);
const as = () => ({ requestId: randomUUID(), actorId: ownerId });
const version = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).version;
const call = (path: string, who: string, body?: unknown) =>
  fetch(`${base}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: cookies[who] ?? "",
      origin: ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
/** Every row of the four daily tables, without the recompute time. */
const dailyRows = async () =>
  JSON.stringify(
    await pool
      .query(
        `SELECT t, r FROM (
        SELECT 'sales' AS t, (row_to_json(s)::jsonb - 'computed_at')::text AS r FROM sales_daily s
        UNION ALL SELECT 'products', (row_to_json(p)::jsonb - 'computed_at')::text FROM product_sales_daily p
        UNION ALL SELECT 'search', (row_to_json(x)::jsonb - 'computed_at')::text FROM search_daily x
        UNION ALL SELECT 'wishlist', (row_to_json(w)::jsonb - 'computed_at')::text FROM wishlist_daily w
      ) daily ORDER BY t, r`,
      )
      .then((result) => result.rows),
  );

describe("M10 acceptance: dashboards, analytics, reports and SEO agree (real API and PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const role = async (key: string, permissions?: string[]) => {
      if (!permissions) return (await db.role.findUniqueOrThrow({ where: { key } })).id;
      const created = await db.role.create({ data: { key, name: key } });
      await pool.query(
        "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2)",
        [created.id, permissions],
      );
      return created.id;
    };
    const login = async (who: string, roleId: string) => {
      const email = `${who}@m10.iqoshaven.test`;
      const user = await db.staffUser.create({
        data: { email, name: who, roleId, passwordHash: await hasher.hash(PASSWORD) },
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
      cookies[who] = response.headers.get("set-cookie")!.split(";")[0]!;
      return user.id;
    };
    ownerId = await login("owner", await role("owner"));
    await login("staff", await role("staff"));
    // Revenue without operations, and exports without revenue or customer data.
    await login("finance", await role("m10_finance", ["dashboard.financial_read"]));
    await login("clerk", await role("m10_clerk", ["reports.read", "reports.export"]));

    // Order 1: placed 23:30 Dubai on A, delivered 00:30 on B, cash collected 10:00 on C.
    const first = await seedOrder(pool, { status: "confirmed", quantity: 2 }); // 10000 + 1500
    for (const to of ["processing", "out_for_delivery", "delivered"] as const)
      await transitionOrder(db, as(), first.orderId, {
        to,
        expectedVersion: await version(first.orderId),
        commandId: randomUUID(),
      });
    // Order 2: placed 23:59 Dubai on A, cancelled now (counts against A's placements).
    const second = await seedOrder(pool); // 5000 + 1500
    await cancelOrder(db, as(), second.orderId, {
      expectedVersion: await version(second.orderId),
      commandId: randomUUID(),
      reason: "Changed mind",
    });
    await pool.query(
      `ALTER TABLE orders DISABLE TRIGGER USER;
       UPDATE orders SET created_at = $1, dispatched_at = $2, delivered_at = $3 WHERE id = $4;
       UPDATE orders SET created_at = $5 WHERE id = $6;
       ALTER TABLE orders ENABLE TRIGGER USER;`
        .replaceAll("$1", `'${dubai(A, "23:30").toISOString()}'`)
        .replaceAll("$2", `'${dubai(B, "00:10").toISOString()}'`)
        .replaceAll("$3", `'${dubai(B, "00:30").toISOString()}'`)
        .replaceAll("$4", `'${first.orderId}'`)
        .replaceAll("$5", `'${dubai(A, "23:59").toISOString()}'`)
        .replaceAll("$6", `'${second.orderId}'`),
    );
    await recordCollection(db, as(), first.orderId, {
      expectedVersion: await version(first.orderId),
      commandId: randomUUID(),
      amountFils: 11_500,
      collectedAt: dubai(C, "10:00").toISOString(),
    });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("puts each basis on its own Dubai day, the same in summary, daily rows, analytics and CSV", async () => {
    await backfillRollups(db, A, C);
    // The live summary, day by day.
    const live = async (day: string) => readFinancialSummary(db, ownerId, { from: day, to: day });
    const [a, b, c] = [await live(A), await live(B), await live(C)];
    expect(a.booked.active).toMatchObject({ orders: 1, totalFils: 11_500 });
    expect(a.cancellation).toMatchObject({ placed: 2, cancelled: 1, rateBps: 5000 });
    expect(a.delivered.orders + a.collected.orders).toBe(0);
    expect(b.delivered).toMatchObject({ orders: 1, totalFils: 11_500, merchandiseNetFils: 10_000 });
    expect(b.booked.active.orders + b.collected.orders).toBe(0);
    expect(c.collected).toMatchObject({ orders: 1, amountFils: 11_500 });
    expect(c.booked.active.orders + c.delivered.orders).toBe(0);

    // Analytics over the three days: the daily rows add up to the live summary.
    const response = await call(`/admin/analytics?from=${A}&to=${C}`, "owner");
    expect(response.status).toBe(200);
    const view = analyticsSchema.parse(await response.json());
    const whole = await readFinancialSummary(db, ownerId, { from: A, to: C });
    expect(view.freshness.missing).toEqual([]);
    expect(view.totals.booked).toEqual(whole.booked.active);
    expect(view.totals.delivered).toMatchObject({
      orders: whole.delivered.orders,
      totalFils: whole.delivered.totalFils,
    });
    expect(view.totals.collected).toMatchObject({
      orders: whole.collected.orders,
      amountFils: whole.collected.amountFils,
    });
    expect(view.totals.cancelled).toMatchObject({ orders: 1, rateBps: 5000 });
    expect(view.days.map((day) => [day.day, day.placed, day.deliveredOrders])).toEqual([
      [A, 2, 0],
      [B, 0, 1],
      [C, 0, 0],
    ]);

    // The sales CSV, each basis: the figure lands on the same day.
    const csv = async (basis: string) => {
      const job = reportJobSchema.parse(
        await (
          await call("/admin/reports", "owner", {
            commandId: randomUUID(),
            report: { type: "sales", from: A, to: C, basis },
          })
        ).json(),
      );
      const text = await (await call(`/admin/reports/${job.id}/download`, "owner")).text();
      return text
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\r\n")
        .slice(1)
        .map((line) => line.split(","));
    };
    expect((await csv("booked")).map((row) => [row[0], row[3], row[6]])).toEqual([
      [A, "1", "115.00"],
      [B, "0", "0.00"],
      [C, "0", "0.00"],
    ]);
    expect((await csv("delivered")).map((row) => [row[0], row[1], row[4]])).toEqual([
      [A, "0", "0.00"],
      [B, "1", "115.00"],
      [C, "0", "0.00"],
    ]);
    expect((await csv("collected")).map((row) => [row[0], row[1], row[2]])).toEqual([
      [A, "0", "0.00"],
      [B, "0", "0.00"],
      [C, "1", "115.00"],
    ]);
  });

  it("gives identical rows however often and however concurrently days are recomputed", async () => {
    const before = await dailyRows();
    // Not a comparison of empty tables: three sales days and the products rows are there.
    expect((before.match(/"t":"sales"/g) ?? []).length).toBe(3);
    expect(before).toMatch(/"t":"products"/);
    await backfillRollups(db, A, C);
    await Promise.all([
      backfillRollups(db, A, C),
      backfillRollups(db, A, C),
      rollupDay(db, B),
      rollupDay(db, A, ["sales", "products"]),
    ]);
    expect(await dailyRows()).toEqual(before);
  });

  it("gives every role exactly its fields on every M10 route", async () => {
    const status = async (who: string, path: string, body?: unknown) =>
      (await call(path, who, body)).status;
    const salesReport = { commandId: randomUUID(), report: { type: "inventory" } };
    const routes: Array<[string, string, unknown?]> = [
      ["analytics", `/admin/analytics?from=${A}&to=${C}`],
      ["reports list", "/admin/reports"],
      ["report request", "/admin/reports", salesReport],
      ["seo overview", "/admin/seo"],
      ["seo issues", "/admin/seo/issues"],
    ];
    const expected: Record<string, number[]> = {
      owner: [200, 200, 201, 200, 200],
      staff: [403, 403, 403, 403, 403],
      finance: [200, 403, 403, 403, 403],
      clerk: [403, 200, 201, 403, 403],
    };
    for (const [who, codes] of Object.entries(expected))
      for (const [index, [, path, body]] of routes.entries())
        expect(
          await status(
            who,
            path,
            body === undefined ? undefined : { ...(body as object), commandId: randomUUID() },
          ),
          `${who} ${routes[index]![0]}`,
        ).toBe(codes[index]);

    // The home dashboard: one route, sections by right.
    const home = async (who: string) =>
      (await (await call("/admin/dashboard", who)).json()) as Record<string, unknown>;
    const sections = (view: Record<string, unknown>) =>
      Object.fromEntries(
        ["orders", "stock", "reviews", "topProducts", "sales"].map((key) => [
          key,
          view[key] !== null,
        ]),
      );
    expect(sections(await home("owner"))).toEqual({
      orders: true,
      stock: true,
      reviews: true,
      topProducts: true,
      sales: true,
    });
    expect(sections(await home("staff"))).toEqual({
      orders: true,
      stock: true,
      reviews: false,
      topProducts: true,
      sales: false,
    });
    expect(sections(await home("finance"))).toEqual({
      orders: false,
      stock: false,
      reviews: false,
      topProducts: false,
      sales: true,
    });
    const staffView = JSON.stringify(await home("staff"));
    expect(staffView).not.toMatch(/netFils":\d|\+971|building/);
    // Customer data needs its own right; another person's report is not found.
    expect(
      await status("clerk", "/admin/reports", {
        commandId: randomUUID(),
        report: { type: "customers" },
      }),
    ).toBe(403);
    const owners = reportJobSchema.parse(
      await (
        await call("/admin/reports", "owner", {
          commandId: randomUUID(),
          report: { type: "inventory" },
        })
      ).json(),
    );
    expect(await status("clerk", `/admin/reports/${owners.id}`)).toBe(404);
    expect(await status("clerk", `/admin/reports/${owners.id}/download`)).toBe(404);
  });
});
