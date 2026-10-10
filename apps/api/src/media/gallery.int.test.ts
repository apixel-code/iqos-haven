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
import type { ProductGalleryResponse } from "@ih/contracts";
import { attachGalleryImage, createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
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
  applicationName: "ih-gallery-test",
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
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
});

let app: INestApplication;
let base: string;
let seq = 0;
let ownerId = "";
let staffId = "";
let brandId = "";
let categoryId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `gallery${seq++}@iqoshaven.test`,
      name: "Gallery Person",
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
  fetch(`${base}/v1/admin/products${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const view = async (response: Response) => (await response.json()) as ProductGalleryResponse;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

async function product() {
  return db.product.create({
    data: {
      name: "Gallery product " + seq++,
      slug: "gallery-product-" + randomUUID().slice(0, 8),
      brandId,
      categoryId,
      type: "kit",
      basePriceFils: 1000n,
    },
  });
}
/** A processed asset (state as the media consumer leaves it). */
async function asset(productId: string, state = "ready", error: string | null = null) {
  const id = randomUUID();
  const keys = Object.fromEntries(
    ["large", "medium", "thumb"].map((name) => [name, `products/${productId}/${id}/${name}.webp`]),
  );
  await pool.query(
    `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
       declared_bytes, state, observed_bytes, width, height, sha256, derivative_keys, error,
       upload_expires_at)
     VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 1000, $4, 1000, 1200, 900,
       repeat('a', 64), $5::jsonb, $6, statement_timestamp() + interval '10 minutes')`,
    [id, productId, staffId, state, JSON.stringify(state === "ready" ? keys : {}), error],
  );
  return id;
}

describe("product image gallery (real API, PostgreSQL and signed links)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
    staffId = staff.id;
    brandId = (await db.brand.create({ data: { name: "Gallery brand", slug: "gallery-brand" } }))
      .id;
    categoryId = (
      await db.category.create({ data: { name: "Gallery category", slug: "gallery-category" } })
    ).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cookies.owner = await login(owner.email);
    cookies.staff = await login(staff.email);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("attaches ready assets with a primary, dense order and short-lived derivative links", async () => {
    const row = await product();
    const first = await asset(row.id);
    const second = await asset(row.id);
    const one = await call(`/${row.id}/images`, "POST", { mediaAssetId: first, alt: "Front view" });
    expect(one.status).toBe(201);
    expect(one.headers.get("cache-control")).toBe("no-store");
    const two = await view(await call(`/${row.id}/images`, "POST", { mediaAssetId: second }));
    expect(two.images.map((i) => [i.mediaAssetId, i.isPrimary, i.sortOrder])).toEqual([
      [first, true, 0],
      [second, false, 1],
    ]);
    const url = new URL(two.images[0]!.urls.large);
    expect(url.pathname).toContain(storageEnv.S3_BUCKET_MEDIA);
    expect(url.pathname).not.toContain(storageEnv.S3_BUCKET_QUARANTINE);
    expect(url.pathname).toMatch(/large\.webp$/);
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(600);
    // Attaching the same asset again changes nothing.
    const again = await view(await call(`/${row.id}/images`, "POST", { mediaAssetId: second }));
    expect(again.images).toHaveLength(2);
    const audit = await db.auditLog.findMany({ where: { action: "catalog.image_attached" } });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("only ever attaches processed assets of the same product", async () => {
    const row = await product();
    const other = await product();
    for (const state of ["uploaded", "processing", "rejected", "removed"])
      expect(
        await code(
          await call(`/${row.id}/images`, "POST", { mediaAssetId: await asset(row.id, state) }),
        ),
      ).toBe("MEDIA_NOT_READY");
    expect(
      (await call(`/${row.id}/images`, "POST", { mediaAssetId: await asset(other.id) })).status,
    ).toBe(404);
    // The database refuses it too.
    const pending = await asset(row.id, "uploaded");
    await expect(
      pool.query(
        `INSERT INTO product_images (product_id, media_asset_id, asset_key, width, height, mime)
         VALUES ($1, $2, 'products/x/y/large.webp', 1, 1, 'image/webp')`,
        [row.id, pending],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Failed uploads stay visible for recovery.
    const failed = await asset(row.id, "rejected", "decode_failed");
    const gallery = await view(await call(`/${row.id}/images`));
    expect(gallery.uploads.find((u) => u.id === failed)).toMatchObject({
      state: "rejected",
      error: "decode_failed",
    });
  });

  it("keeps at most eight images and exactly one primary under concurrency", async () => {
    const row = await product();
    const assets = await Promise.all(Array.from({ length: 10 }, () => asset(row.id)));
    const results = await Promise.allSettled(
      assets.map((mediaAssetId) =>
        attachGalleryImage(db, { actorId: ownerId, requestId: randomUUID() }, row.id, {
          mediaAssetId,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    const gallery = await view(await call(`/${row.id}/images`));
    expect(gallery.images).toHaveLength(8);
    expect(gallery.images.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(gallery.images.map((i) => i.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(
      await code(await call(`/${row.id}/images`, "POST", { mediaAssetId: await asset(row.id) })),
    ).toBe("IMAGE_LIMIT");
  });

  it("edits alt text, moves the primary and reorders exactly the current set", async () => {
    const row = await product();
    const ids = [await asset(row.id), await asset(row.id), await asset(row.id)];
    for (const mediaAssetId of ids) await call(`/${row.id}/images`, "POST", { mediaAssetId });
    let gallery = await view(await call(`/${row.id}/images`));
    const [a, b, c] = gallery.images as [
      ProductGalleryResponse["images"][number],
      ProductGalleryResponse["images"][number],
      ProductGalleryResponse["images"][number],
    ];
    expect(
      await code(
        await call(`/${row.id}/images/${a.id}`, "PATCH", {
          version: a.version,
          alt: "",
          isPrimary: false,
        }),
      ),
    ).toBe("DEFAULT_REQUIRED");
    gallery = await view(
      await call(`/${row.id}/images/${c.id}`, "PATCH", {
        version: c.version,
        alt: "Side view",
        isPrimary: true,
      }),
    );
    expect(gallery.images.find((i) => i.id === c.id)).toMatchObject({
      isPrimary: true,
      alt: "Side view",
    });
    expect(gallery.images.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(
      await code(
        await call(`/${row.id}/images/${c.id}`, "PATCH", {
          version: c.version,
          alt: "x",
          isPrimary: true,
        }),
      ),
    ).toBe("VERSION_CONFLICT");
    gallery = await view(
      await call(`/${row.id}/images/order`, "PUT", { imageIds: [c.id, a.id, b.id] }),
    );
    expect(gallery.images.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    for (const imageIds of [
      [c.id, a.id],
      [c.id, a.id, b.id, randomUUID()],
      [c.id, c.id, a.id],
    ])
      expect((await call(`/${row.id}/images/order`, "PUT", { imageIds })).status).not.toBe(200);
    expect(
      await code(await call(`/${row.id}/images/order`, "PUT", { imageIds: [c.id, a.id] })),
    ).toBe("ORDER_MISMATCH");
  });

  it("removes images, promotes the next primary and frees the upload slot", async () => {
    const row = await product();
    const ids = [await asset(row.id), await asset(row.id)];
    for (const mediaAssetId of ids) await call(`/${row.id}/images`, "POST", { mediaAssetId });
    const before = await view(await call(`/${row.id}/images`));
    const primary = before.images[0]!;
    const after = await view(
      await call(`/${row.id}/images/${primary.id}/remove`, "POST", { version: primary.version }),
    );
    expect(after.images).toHaveLength(1);
    expect(after.images[0]).toMatchObject({ mediaAssetId: ids[1], isPrimary: true, sortOrder: 0 });
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: ids[0]! } })).state).toBe(
      "removed",
    );
    // The removed asset no longer occupies one of the eight upload slots.
    const occupying = await pool.query(
      "SELECT count(*)::int AS n FROM media_assets WHERE product_id=$1 AND state IN ('uploaded','processing','ready')",
      [row.id],
    );
    expect(occupying.rows[0].n).toBe(1);
  });

  it("guards gallery integrity in the database as well", async () => {
    const row = await product();
    const other = await product();
    const foreign = await asset(other.id);
    await expect(
      pool.query(
        `INSERT INTO product_images (product_id, media_asset_id, asset_key, width, height, mime)
         VALUES ($1, $2, 'products/x/y/large.webp', 1, 1, 'image/webp')`,
        [row.id, foreign],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const attachedId = await asset(row.id);
    const gallery = await view(
      await call(`/${row.id}/images`, "POST", { mediaAssetId: attachedId }),
    );
    // An attached asset cannot leave `ready` or move to another product.
    for (const sql of [
      "UPDATE media_assets SET state='rejected' WHERE id=$1",
      "UPDATE media_assets SET state='removed' WHERE id=$1",
    ])
      await expect(pool.query(sql, [attachedId])).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE media_assets SET product_id=$2 WHERE id=$1", [attachedId, other.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const image = gallery.images[0]!;
    expect(
      await code(
        await call(`/${row.id}/images/${image.id}/remove`, "POST", { version: image.version + 1 }),
      ),
    ).toBe("VERSION_CONFLICT");
    await call(`/${row.id}/images/${image.id}/remove`, "POST", { version: image.version });
    // A removed asset cannot come back; the file must be uploaded again.
    expect(await code(await call(`/${row.id}/images`, "POST", { mediaAssetId: attachedId }))).toBe(
      "MEDIA_NOT_READY",
    );
    // An asset missing a derivative is never attached.
    const partial = await asset(row.id);
    await pool.query(
      "UPDATE media_assets SET derivative_keys=derivative_keys - 'thumb' WHERE id=$1",
      [partial],
    );
    expect(await code(await call(`/${row.id}/images`, "POST", { mediaAssetId: partial }))).toBe(
      "MEDIA_NOT_READY",
    );
  });

  it("requires catalogue permissions and refuses changes to trashed products", async () => {
    const row = await product();
    const ready = await asset(row.id);
    expect((await call(`/${row.id}/images`, "GET", undefined, "")).status).toBe(401);
    expect((await call(`/${randomUUID()}/images`)).status).toBe(404);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "catalog.write" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect((await call(`/${row.id}/images`, "POST", { mediaAssetId: ready })).status).toBe(403);
      expect((await call(`/${row.id}/images`)).status).toBe(200);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
    await db.product.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    expect(await code(await call(`/${row.id}/images`, "POST", { mediaAssetId: ready }))).toBe(
      "TRASHED",
    );
  });
});
