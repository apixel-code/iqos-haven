import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { reportJobSchema, reportJobsResponseSchema } from "@ih/contracts";
import { createDatabase, createPool, requestReport } from "@ih/db";
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
  applicationName: "ih-admin-reports-test",
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
let clerk = "";
let clerkRoleId = "";
let host = 10;
const today = () => dubaiDate(new Date());
const call = (path: string, cookie: string, body?: unknown) =>
  fetch(`${base}/v1/admin/reports${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      origin: ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const sales = () => ({ type: "sales", from: addDays(today(), -6), to: today(), basis: "booked" });

describe("report requests and status through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (roleId: string, email: string) => {
      const user = await db.staffUser.create({
        data: { email, name: "Rep", roleId, passwordHash: await hasher.hash(PASSWORD) },
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
    const role = async (key: string) => (await db.role.findUniqueOrThrow({ where: { key } })).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login(await role("owner"), "rep-owner@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = (await login(await role("staff"), "rep-staff@iqoshaven.test")).cookie;
    // A role that may export reports but not customer data.
    clerkRoleId = (await db.role.create({ data: { key: "report_clerk_test", name: "Reports" } }))
      .id;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('reports.read','reports.export')",
      [clerkRoleId],
    );
    clerk = (await login(clerkRoleId, "rep-clerk@iqoshaven.test")).cookie;
    await seedOrder(pool);
    await seedOrder(pool, { quantity: 2 });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses without a session, without the right, and invalid parameters", async () => {
    const body = { commandId: randomUUID(), report: sales() };
    expect((await fetch(`${base}/v1/admin/reports`)).status).toBe(401);
    expect((await call("", staff, body)).status).toBe(403);
    expect((await call("", staff)).status).toBe(403);
    for (const report of [
      { type: "payroll" },
      { ...sales(), basis: "gross" },
      { ...sales(), from: "2026-02-30" },
      { ...sales(), from: "2024-01-01", to: "2026-01-01" },
      { ...sales(), to: addDays(today(), 1) },
      { type: "inventory", from: today(), to: today() },
      { ...sales(), extra: true },
    ])
      expect((await call("", owner, { commandId: randomUUID(), report })).status).toBe(400);
    expect((await call("", owner, { report: sales() })).status).toBe(400);
    expect(await db.reportJob.count()).toBe(0);
  });

  it("streams a small report, replays the same command and refuses it reused", async () => {
    const commandId = randomUUID();
    const first = await call("", owner, { commandId, report: sales() });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const job = reportJobSchema.parse(await first.json());
    expect(job).toMatchObject({
      type: "sales",
      report: sales(),
      delivery: "stream",
      status: "ready",
      estimatedRows: 7,
      available: true,
    });
    const minutes = (Date.parse(job.expiresAt!) - Date.parse(job.createdAt)) / 60_000;
    expect(minutes).toBeCloseTo(15, 3);
    const again = await call("", owner, { commandId, report: sales() });
    expect(again.status).toBe(200);
    expect(reportJobSchema.parse(await again.json()).id).toBe(job.id);
    const reused = await call("", owner, { commandId, report: { type: "inventory" } });
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await db.reportJob.count({ where: { commandId } })).toBe(1);
    // One audit entry for the request, with what was asked; streams write no event.
    const audit = await db.auditLog.findMany({ where: { entityId: job.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "report.requested", actorId: ownerId });
    expect(await db.outboxEvent.count({ where: { aggregateId: job.id } })).toBe(0);
  });

  it("estimates the order report by lines and needs customers.export for personal data", async () => {
    const orders = reportJobSchema.parse(
      await (
        await call("", owner, {
          commandId: randomUUID(),
          report: { type: "orders", from: today(), to: today() },
        })
      ).json(),
    );
    expect(orders.estimatedRows).toBe(2);
    expect(
      (await call("", clerk, { commandId: randomUUID(), report: { type: "customers" } })).status,
    ).toBe(403);
    // The orders report holds names and phones too (step 111).
    expect(
      (
        await call("", clerk, {
          commandId: randomUUID(),
          report: { type: "orders", from: today(), to: today() },
        })
      ).status,
    ).toBe(403);
    expect((await call("", clerk, { commandId: randomUUID(), report: sales() })).status).toBe(201);
    const customers = await call("", owner, {
      commandId: randomUUID(),
      report: { type: "customers" },
    });
    expect(customers.status).toBe(201);
    const row = await db.reportJob.findUniqueOrThrow({
      where: { id: reportJobSchema.parse(await customers.json()).id },
    });
    expect(row.requiredPermissions.sort()).toEqual(["customers.export", "reports.export"]);
  });

  it("queues a large report as a file job with its event, and keeps request fields fixed", async () => {
    const { job, created } = await requestReport(
      db,
      { requestId: randomUUID(), actorId: ownerId },
      { commandId: randomUUID(), report: { type: "inventory" } },
      { streamMaxRows: 0 },
    );
    expect(created).toBe(true);
    expect(job).toMatchObject({
      delivery: "file",
      status: "queued",
      expiresAt: null,
      available: false,
    });
    const events = await db.outboxEvent.findMany({ where: { aggregateId: job.id } });
    expect(events).toMatchObject([
      { eventType: "report.requested", payload: { reportJobId: job.id } },
    ]);
    await expect(
      pool.query("UPDATE report_jobs SET type='sales' WHERE id=$1", [job.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("UPDATE report_jobs SET requested_by=$1 WHERE id=$2", [randomUUID(), job.id]),
    ).rejects.toThrow();
    // Completing it (as step 112's worker will), then the file it names is fixed.
    await pool.query(
      "UPDATE report_jobs SET status='completed', artifact_key='k1', row_count=1, completed_at=now(), expires_at=now() + interval '7 days' WHERE id=$1",
      [job.id],
    );
    await expect(
      pool.query("UPDATE report_jobs SET artifact_key='k2' WHERE id=$1", [job.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("UPDATE report_jobs SET status='queued' WHERE id=$1", [job.id]),
    ).rejects.toThrow(/cannot change state/);
  });

  it("shows each requester only their own jobs; a guessed ID is not found", async () => {
    const mine = reportJobsResponseSchema.parse(await (await call("", owner)).json());
    const theirs = reportJobsResponseSchema.parse(await (await call("", clerk)).json());
    expect(mine.items.length).toBeGreaterThanOrEqual(3);
    expect(theirs.items).toHaveLength(1);
    expect(mine.items.map((job) => job.id)).not.toContain(theirs.items[0]!.id);
    // Newest first.
    const times = mine.items.map((job) => Date.parse(job.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await call("/" + mine.items[0]!.id, owner)).status).toBe(200);
    expect((await call("/" + mine.items[0]!.id, clerk)).status).toBe(404);
    expect((await call("/" + randomUUID(), clerk)).status).toBe(404);
    expect((await call("/not-a-uuid", clerk)).status).toBe(400);
    // Without reports.read the list and status are refused.
    await pool.query(
      "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='reports.read'",
      [clerkRoleId],
    );
    expect((await call("", clerk)).status).toBe(403);
    expect((await call("/" + theirs.items[0]!.id, clerk)).status).toBe(403);
  });
});
