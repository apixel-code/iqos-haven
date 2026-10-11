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
import type { MediaAsset, MediaUploadResponse } from "@ih/contracts";
import { authorizeMediaUpload, createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
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
  applicationName: "ih-media-test",
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
let base: string;
let seq = 0;
let ownerId = "";
let brandId = "";
let categoryId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };
const keys: string[] = [];

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `media${seq++}@iqoshaven.test`,
      name: "Media Person",
      roleId: role.id,
      passwordHash: await hasher.hash(PASSWORD),
    },
  });
}
async function login(email: string) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (path: string, method = "GET", body?: unknown, cookie = cookies.staff) =>
  fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
async function product() {
  return db.product.create({
    data: {
      name: "Media product " + seq++,
      slug: "media-product-" + randomUUID().slice(0, 8),
      brandId,
      categoryId,
      type: "kit",
      basePriceFils: 1000n,
    },
  });
}
async function authorize(productId: string, bytes = 512, contentType = "image/jpeg") {
  const response = await call(`/products/${productId}/media/uploads`, "POST", {
    contentType,
    bytes,
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as MediaUploadResponse;
  keys.push("uploads/" + body.asset.id);
  return body;
}
function upload(
  grant: MediaUploadResponse,
  bytes: number,
  overrides: Record<string, string> = {},
  type = "image/jpeg",
) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...grant.upload.fields, ...overrides }))
    form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type }));
  return fetch(grant.upload.url, { method: "POST", body: form });
}
const complete = (assetId: string, cookie = cookies.staff) =>
  call(`/media/${assetId}/complete`, "POST", {}, cookie);

describe("quarantine upload authorization (real API, PostgreSQL and MinIO)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
    brandId = (await db.brand.create({ data: { name: "Media brand", slug: "media-brand" } })).id;
    categoryId = (
      await db.category.create({ data: { name: "Media category", slug: "media-category" } })
    ).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cookies.owner = await login(owner.email);
    cookies.staff = await login(staff.email);
  });
  afterAll(async () => {
    for (const key of keys) await storage.delete("quarantine", key).catch(() => undefined);
    storage.destroy();
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("authorizes a private upload, accepts the bytes and queues processing", async () => {
    const row = await product();
    const grant = await authorize(row.id, 600);
    expect(grant.asset).toMatchObject({ state: "pending", declaredBytes: 600, productId: row.id });
    expect(grant.upload.fields.key).toBe("uploads/" + grant.asset.id);
    expect(grant.upload.url).not.toContain("ih-media");
    expect((await upload(grant, 600)).status).toBe(204);
    const done = await complete(grant.asset.id);
    expect(done.status).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect((await done.json()) as MediaAsset).toMatchObject({
      state: "uploaded",
      observedBytes: 600,
    });
    const events = await db.outboxEvent.findMany({ where: { aggregateId: grant.asset.id } });
    expect(events.map((e) => [e.eventType, e.payload])).toEqual([
      ["media.uploaded", { mediaAssetId: grant.asset.id }],
    ]);
    const audit = await db.auditLog.findMany({
      where: { entityId: grant.asset.id },
      orderBy: { id: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual([
      "media.upload_authorized",
      "media.upload_completed",
    ]);
    const stored = await db.mediaAsset.findUniqueOrThrow({ where: { id: grant.asset.id } });
    expect(stored.observedEtag).toMatch(/^[0-9a-f-]{8,}$/);
    // Completing again changes nothing.
    expect(((await (await complete(grant.asset.id)).json()) as MediaAsset).state).toBe("uploaded");
    expect(await db.outboxEvent.count({ where: { aggregateId: grant.asset.id } })).toBe(1);
  });

  it("lets storage refuse oversized, re-keyed and re-typed uploads", async () => {
    const row = await product();
    const grant = await authorize(row.id, 512);
    expect((await upload(grant, 513)).status).toBe(400);
    expect((await upload(grant, 16, { key: "uploads/" + randomUUID() })).status).toBe(403);
    expect((await upload(grant, 16, { "Content-Type": "text/html" }, "text/html")).status).toBe(
      403,
    );
    // Nothing arrived, so completion reports the missing upload.
    expect(await code(await complete(grant.asset.id))).toBe("UPLOAD_MISSING");
  });

  it("rejects objects that contradict the authorization and frees their slot", async () => {
    const row = await product();
    const big = await authorize(row.id, 64);
    // Written around the policy (as a compromised or misconfigured client could): not trusted.
    await storage.put("quarantine", "uploads/" + big.asset.id, new Uint8Array(128), "image/jpeg");
    expect((await (await complete(big.asset.id)).json()) as MediaAsset).toMatchObject({
      state: "rejected",
      error: "size_mismatch",
      observedBytes: null,
    });
    const typed = await authorize(row.id, 64);
    await storage.put("quarantine", "uploads/" + typed.asset.id, new Uint8Array(32), "text/html");
    expect(((await (await complete(typed.asset.id)).json()) as MediaAsset).error).toBe(
      "type_mismatch",
    );
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: { in: [big.asset.id, typed.asset.id] } },
      }),
    ).toBe(0);
    const audit = await db.auditLog.findMany({ where: { entityId: big.asset.id } });
    expect(audit.map((a) => a.action)).toContain("media.upload_rejected");
    // Rejected assets no longer occupy image slots.
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM media_assets WHERE product_id=$1 AND state IN ('pending','uploaded','processing','ready')",
      [row.id],
    );
    expect(count.rows[0].n).toBe(0);
  });

  it("refuses completion once the product is trashed", async () => {
    const row = await product();
    const grant = await authorize(row.id, 32);
    expect((await upload(grant, 32)).status).toBe(204);
    await db.product.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    expect(await code(await complete(grant.asset.id))).toBe("TRASHED");
  });

  it("validates the declared file before signing anything", async () => {
    const row = await product();
    for (const body of [
      { contentType: "image/svg+xml", bytes: 100 },
      { contentType: "image/gif", bytes: 100 },
      { contentType: "image/jpeg", bytes: 0 },
      { contentType: "image/jpeg", bytes: 8 * 1024 * 1024 + 1 },
      { contentType: "image/jpeg", bytes: 100, key: "uploads/mine" },
    ])
      expect((await call(`/products/${row.id}/media/uploads`, "POST", body)).status).toBe(400);
    expect(
      (
        await call(`/products/${randomUUID()}/media/uploads`, "POST", {
          contentType: "image/png",
          bytes: 1,
        })
      ).status,
    ).toBe(404);
    expect(await db.mediaAsset.count({ where: { productId: row.id } })).toBe(0);
  });

  it("enforces the eight-image limit under concurrency; expired grants free their slot", async () => {
    const row = await product();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        authorizeMediaUpload(db, { actorId: ownerId, requestId: randomUUID() }, row.id, {
          contentType: "image/png",
          bytes: 100,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    expect(
      await code(
        await call(`/products/${row.id}/media/uploads`, "POST", {
          contentType: "image/png",
          bytes: 1,
        }),
      ),
    ).toBe("IMAGE_LIMIT");
    await pool.query(
      "UPDATE media_assets SET upload_expires_at=statement_timestamp() - interval '1 second' WHERE id=(SELECT id FROM media_assets WHERE product_id=$1 ORDER BY id LIMIT 1)",
      [row.id],
    );
    expect(
      (
        await call(`/products/${row.id}/media/uploads`, "POST", {
          contentType: "image/png",
          bytes: 1,
        })
      ).status,
    ).toBe(201);
    const list = (await (await call(`/products/${row.id}/media`)).json()) as {
      items: MediaAsset[];
    };
    expect(list.items).toHaveLength(9);
    expect(list.items.filter((i) => i.state === "expired")).toHaveLength(1);
  });

  it("refuses completion after the authorization expired", async () => {
    const row = await product();
    const grant = await authorize(row.id, 64);
    expect((await upload(grant, 64)).status).toBe(204);
    await pool.query(
      "UPDATE media_assets SET upload_expires_at=statement_timestamp() - interval '1 second' WHERE id=$1",
      [grant.asset.id],
    );
    expect(await code(await complete(grant.asset.id))).toBe("UPLOAD_EXPIRED");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: grant.asset.id } })).state).toBe(
      "pending",
    );
  });

  it("requires catalogue write and media upload permissions; trashed products refuse uploads", async () => {
    const row = await product();
    expect((await call(`/products/${row.id}/media`, "GET", undefined, "")).status).toBe(401);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "media.upload" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect(
        (
          await call(`/products/${row.id}/media/uploads`, "POST", {
            contentType: "image/png",
            bytes: 1,
          })
        ).status,
      ).toBe(403);
      expect((await call(`/products/${row.id}/media`)).status).toBe(200);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
    await db.product.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    expect(
      await code(
        await call(`/products/${row.id}/media/uploads`, "POST", {
          contentType: "image/png",
          bytes: 1,
        }),
      ),
    ).toBe("TRASHED");
  });
});
