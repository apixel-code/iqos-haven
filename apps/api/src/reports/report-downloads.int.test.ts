import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { reportJobSchema } from "@ih/contracts";
import {
  createDatabase,
  createPool,
  reportRows,
  requestReport,
  rollupDay,
  transitionOrder,
} from "@ih/db";
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
  applicationName: "ih-report-downloads-test",
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
const ATTACK = '=HYPERLINK("http://evil.test","x")';

let app: INestApplication;
let base = "";
let owner = "";
let ownerId = "";
let clerk = "";
let clerkRoleId = "";
let host = 10;
const today = () => dubaiDate(new Date());
const headers = (cookie: string) => ({
  cookie,
  origin: ADMIN,
  "content-type": "application/json",
  "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
});
async function request(cookie: string, report: unknown) {
  const response = await fetch(`${base}/v1/admin/reports`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify({ commandId: randomUUID(), report }),
  });
  expect(response.status).toBe(201);
  return reportJobSchema.parse(await response.json());
}
const download = (cookie: string, id: string) =>
  fetch(`${base}/v1/admin/reports/${id}/download`, { headers: headers(cookie) });

/** RFC 4180 parse: rows of fields (the test's own reader, independent of the writer). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  return rows;
}
async function csvOf(cookie: string, report: unknown) {
  const job = await request(cookie, report);
  const response = await download(cookie, job.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const disposition = response.headers.get("content-disposition")!;
  // The UTF-8 byte-order mark is there for spreadsheets (decoding drops it).
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  const [header, ...rows] = parseCsv(text);
  return { job, header: header!, rows, disposition, raw: text };
}

describe("report CSV downloads through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (roleId: string, email: string) => {
      const user = await db.staffUser.create({
        data: { email, name: "Csv", roleId, passwordHash: await hasher.hash(PASSWORD) },
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
    const o = await login(
      (await db.role.findUniqueOrThrow({ where: { key: "owner" } })).id,
      "csv-owner@iqoshaven.test",
    );
    owner = o.cookie;
    ownerId = o.id;
    clerkRoleId = (await db.role.create({ data: { key: "csv_clerk_test", name: "Reports" } })).id;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('reports.read','reports.export','customers.export')",
      [clerkRoleId],
    );
    clerk = (await login(clerkRoleId, "csv-clerk@iqoshaven.test")).cookie;

    const pending = await seedOrder(pool); // 5000 + 1500
    const delivered = await seedOrder(pool, { status: "confirmed", quantity: 2 }); // 10000 + 1500
    for (const to of ["processing", "out_for_delivery", "delivered"] as const) {
      const { version } = await db.order.findUniqueOrThrow({ where: { id: delivered.orderId } });
      await transitionOrder(db, { requestId: randomUUID(), actorId: ownerId }, delivered.orderId, {
        to,
        expectedVersion: version,
        commandId: randomUUID(),
      });
    }
    // Names a shopper typed that a spreadsheet would run: the order snapshot and the customer.
    await pool.query(
      `ALTER TABLE orders DISABLE TRIGGER USER;
       UPDATE orders SET customer_name = $$${ATTACK}$$ WHERE id = '${pending.orderId}';
       ALTER TABLE orders ENABLE TRIGGER USER;
       ALTER TABLE customers DISABLE TRIGGER USER;
       UPDATE customers SET display_name = $$${ATTACK}$$ WHERE id = '${pending.customerId}';
       ALTER TABLE customers ENABLE TRIGGER USER;`,
    );
    // Real orders set it when the first order commits (seedOrder does not).
    await pool.query(
      "UPDATE customers c SET first_order_at = (SELECT min(created_at) FROM orders o WHERE o.customer_id=c.id) WHERE first_order_at IS NULL",
    );
    await rollupDay(db, today());
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("sales: one row per Dubai day on the chosen basis, days not computed say so", async () => {
    const from = addDays(today(), -2);
    const booked = await csvOf(owner, { type: "sales", from, to: today(), basis: "booked" });
    expect(booked.disposition).toBe(
      `attachment; filename="iqos-haven-sales-booked-${from}-to-${today()}.csv"`,
    );
    expect(booked.header[0]).toBe("Date (Dubai, order placed)");
    expect(booked.rows).toHaveLength(3);
    expect(booked.rows[0]!.at(-1)).toBe("not computed");
    expect(booked.rows[0]!.slice(1, -1).every((cell) => cell === "")).toBe(true);
    // Today: 2 placed, both booked, AED 180.00, AOV 90.00, no cancellations.
    expect(booked.rows[2]!.slice(0, 9)).toEqual([
      today(),
      "2",
      "0",
      "2",
      "150.00",
      "30.00",
      "180.00",
      "90.00",
      "0.00",
    ]);
    const delivered = await csvOf(owner, {
      type: "sales",
      from: today(),
      to: today(),
      basis: "delivered",
    });
    expect(delivered.header[0]).toBe("Date (Dubai, delivered)");
    expect(delivered.rows[0]!.slice(0, 5)).toEqual([today(), "1", "100.00", "15.00", "115.00"]);
    const collected = await csvOf(owner, {
      type: "sales",
      from: today(),
      to: today(),
      basis: "collected",
    });
    expect(collected.rows[0]!.slice(0, 4)).toEqual([today(), "0", "0.00", ""]);
  });

  it("orders: one row per line with snapshots; text that would run as a formula is defused", async () => {
    const { header, rows, raw } = await csvOf(owner, {
      type: "orders",
      from: today(),
      to: today(),
    });
    // PRIV-01 (step 118): exactly these columns; personal data is the name, phone and area only.
    expect(header).toEqual([
      "Order",
      "Placed at (Dubai)",
      "Status now",
      "Source",
      "Customer",
      "Phone",
      "Area",
      "Emirate",
      "Product (as sold)",
      "Brand (as sold)",
      "Category (as sold)",
      "SKU",
      "Quantity",
      "Unit price (AED)",
      "Line discount (AED)",
      "Line total (AED)",
      "Order merchandise (AED)",
      "Order discount (AED)",
      "Delivery fee (AED)",
      "Order total (AED)",
      "Coupon",
      "Payment",
      "Cash",
    ]);
    expect(rows).toHaveLength(2);
    const customer = header.indexOf("Customer");
    const phone = header.indexOf("Phone");
    const names = rows.map((row) => row[customer]);
    expect(names).toContain("'" + ATTACK);
    expect(names.every((name) => !name!.startsWith("="))).toBe(true);
    expect(rows.every((row) => row[phone]!.startsWith("'+971"))).toBe(true);
    expect(rows.map((row) => row[header.indexOf("Status now")]).sort()).toEqual([
      "Delivered",
      "Pending",
    ]);
    expect(rows.map((row) => row[header.indexOf("Order total (AED)")]).sort()).toEqual([
      "115.00",
      "65.00",
    ]);
    expect(raw).not.toMatch(/building|Villa/i);
  });

  it("products, inventory and customers carry their date or snapshot basis", async () => {
    const products = await csvOf(owner, { type: "products", from: today(), to: today() });
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0]!.slice(3)).toEqual(["2", "1", "0.00", "100.00"]);
    const inventory = await csvOf(owner, { type: "inventory" });
    expect(inventory.disposition).toContain(`iqos-haven-inventory-as-of-${today()}.csv`);
    expect(inventory.rows).toHaveLength(2);
    expect(inventory.header.at(-1)).toBe("Snapshot at (Dubai)");
    expect(inventory.rows.every((row) => row[7] === "Out of stock")).toBe(true);
    const customers = await csvOf(owner, { type: "customers" });
    expect(customers.header).toEqual([
      "Customer",
      "Phone",
      "Orders placed",
      "Orders cancelled",
      "Booked spend (AED, not cancelled)",
      "Delivered spend (AED)",
      "First order (Dubai)",
      "Last order (Dubai)",
      "Areas",
      "Snapshot at (Dubai)",
    ]);
    // No address, notes, Makani or staff email in any customer-data export.
    expect(customers.raw).not.toMatch(/building|villa|makani|notes|@iqoshaven/i);
    expect(customers.rows).toHaveLength(2);
    expect(customers.rows.map((row) => row[0])).toContain("'" + ATTACK);
    expect(customers.rows.map((row) => row[5]).sort()).toEqual(["0.00", "115.00"]);
    // Every download is audited; the personal-data ones say so.
    const audits = await db.auditLog.findMany({
      where: { action: "report.downloaded", entityId: customers.job.id },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.diff)).toMatch(/personalData/);
  });

  it("downloads only for the requester, while live and with the rights still held", async () => {
    const job = await request(owner, { type: "inventory" });
    expect((await download(clerk, job.id)).status).toBe(404);
    expect((await download(clerk, randomUUID())).status).toBe(404);
    expect((await fetch(`${base}/v1/admin/reports/${job.id}/download`)).status).toBe(401);
    // Expired: refused with the stable code.
    await pool.query(
      "UPDATE report_jobs SET expires_at = now() - interval '1 second' WHERE id=$1",
      [job.id],
    );
    const expired = await download(owner, job.id);
    expect(expired.status).toBe(409);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      "REPORT_NOT_AVAILABLE",
    );
    // A file job is downloaded through step 112, not streamed.
    const { job: file } = await requestReport(
      db,
      { requestId: randomUUID(), actorId: ownerId },
      { commandId: randomUUID(), report: { type: "inventory" } },
      { streamMaxRows: 0 },
    );
    expect((await download(owner, file.id)).status).toBe(409);
    // The clerk asked for customer data, then lost customers.export: no download.
    const theirs = await request(clerk, { type: "customers" });
    await pool.query(
      "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='customers.export'",
      [clerkRoleId],
    );
    expect((await download(clerk, theirs.id)).status).toBe(403);
    expect(
      await db.auditLog.count({ where: { action: "report.downloaded", entityId: theirs.id } }),
    ).toBe(0);
  });

  it("never repeats or skips a row across batch boundaries (microsecond timestamps)", async () => {
    // More orders placed within the same moment-ish, so batches of one cross many boundaries.
    for (let i = 0; i < 4; i++) await seedOrder(pool, { quantity: 1 });
    await pool.query(
      "UPDATE customers c SET first_order_at = (SELECT min(created_at) FROM orders o WHERE o.customer_id=c.id) WHERE first_order_at IS NULL",
    );
    const collect = async (report: Parameters<typeof reportRows>[1], batch?: number) => {
      const rows: unknown[][] = [];
      for await (const row of reportRows(db, report, new Date(), batch)) rows.push(row);
      return rows.slice(1).map((row) => JSON.stringify(row));
    };
    for (const report of [
      { type: "orders", from: today(), to: today() },
      { type: "inventory" },
      { type: "customers" },
    ] as const) {
      const whole = await collect(report);
      const paged = await collect(report, 1);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(paged.length);
    }
    expect((await collect({ type: "orders", from: today(), to: today() }, 1)).length).toBe(6);
  });
});
