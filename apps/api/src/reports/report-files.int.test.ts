import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  buildReportFile,
  completeReportFile,
  createDatabase,
  createPool,
  requestReport,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { Argon2PasswordHasher, ObjectStorage, storageConfigFromEnv } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-report-files-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const storage = new ObjectStorage(
  storageConfigFromEnv({ ...storageEnv, S3_FORCE_PATH_STYLE: true }),
);
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
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
});

let app: INestApplication;
let base = "";
let owner = "";
let ownerId = "";
let clerk = "";
let clerkId = "";
let clerkRoleId = "";
let host = 10;
const keys: string[] = [];
const download = (cookie: string, id: string) =>
  fetch(`${base}/v1/admin/reports/${id}/download`, {
    redirect: "manual",
    headers: { cookie, "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}` },
  });
/** A built file job for `actorId`, as the worker would leave it. */
async function builtFile(actorId: string, report: Parameters<typeof requestReport>[2]["report"]) {
  const { job } = await requestReport(
    db,
    { requestId: randomUUID(), actorId },
    { commandId: randomUUID(), report },
    { streamMaxRows: -1 },
  );
  const build = await buildReportFile(db, job.id);
  if (build.outcome !== "built") throw new Error("not built: " + build.outcome);
  const bytes = new TextEncoder().encode(build.text);
  await storage.put("reports", build.key, bytes, "text/csv; charset=utf-8");
  keys.push(build.key);
  expect(
    await completeReportFile(db, job.id, {
      key: build.key,
      rowCount: build.rowCount,
      byteSize: bytes.byteLength,
    }),
  ).toBe(true);
  return job;
}

describe("built report files: signed download through the real API, PostgreSQL and MinIO", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (roleId: string, email: string) => {
      const user = await db.staffUser.create({
        data: { email, name: "File", roleId, passwordHash: await hasher.hash(PASSWORD) },
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
      "file-owner@iqoshaven.test",
    );
    owner = o.cookie;
    ownerId = o.id;
    clerkRoleId = (await db.role.create({ data: { key: "file_clerk_test", name: "Rep" } })).id;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('reports.read','reports.export','customers.export')",
      [clerkRoleId],
    );
    const c = await login(clerkRoleId, "file-clerk@iqoshaven.test");
    clerk = c.cookie;
    clerkId = c.id;
    await seedOrder(pool);
  });
  afterAll(async () => {
    await app?.close();
    for (const key of keys) await storage.delete("reports", key).catch(() => undefined);
    storage.destroy();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("redirects the requester to a five-minute signed link of the private file, audited", async () => {
    const job = await builtFile(ownerId, { type: "inventory" });
    const response = await download(owner, job.id);
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toContain(storageEnv.S3_BUCKET_REPORTS);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^attachment; filename="iqos-haven-inventory-as-of-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    // The signed link works on its own; the bucket itself does not.
    const file = await fetch(location);
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))).toContain("SKU");
    const unsigned = new URL(location.origin + location.pathname);
    expect((await fetch(unsigned)).status).toBe(403);
    expect(
      await db.auditLog.count({ where: { action: "report.downloaded", entityId: job.id } }),
    ).toBe(1);
  });

  it("never signs for anyone else, without the rights, or after expiry", async () => {
    const mine = await builtFile(ownerId, { type: "inventory" });
    expect((await download(clerk, mine.id)).status).toBe(404);
    const theirs = await builtFile(clerkId, { type: "customers" });
    await pool.query(
      "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='customers.export'",
      [clerkRoleId],
    );
    const refused = await download(clerk, theirs.id);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    await pool.query(
      "UPDATE report_jobs SET expires_at = now() - interval '1 second' WHERE id=$1",
      [mine.id],
    );
    const expired = await download(owner, mine.id);
    expect(expired.status).toBe(409);
    expect(expired.headers.get("location")).toBeNull();
    // A file still being built is not available either.
    const { job: queued } = await requestReport(
      db,
      { requestId: randomUUID(), actorId: ownerId },
      { commandId: randomUUID(), report: { type: "inventory" } },
      { streamMaxRows: -1 },
    );
    expect((await download(owner, queued.id)).status).toBe(409);
    for (const id of [theirs.id, mine.id, queued.id])
      expect(
        await db.auditLog.count({ where: { action: "report.downloaded", entityId: id } }),
      ).toBe(0);
  });
});
