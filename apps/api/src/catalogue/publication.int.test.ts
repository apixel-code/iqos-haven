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
import type { ProductReadiness } from "@ih/contracts";
import {
  attachGalleryImage,
  changeProductState,
  createDatabase,
  createPool,
  removeGalleryImage,
} from "@ih/db";
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
  applicationName: "ih-publication-test",
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
let staffId = "";
let brandId = "";
let categoryId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `publication${seq++}@iqoshaven.test`,
      name: "Publication Person",
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
const readiness = async (id: string) =>
  (await (await call(`/${id}/readiness`)).json()) as ProductReadiness;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const version = async (id: string) =>
  (await db.product.findUniqueOrThrow({ where: { id } })).version;

/** A complete product: variant (active default), gallery image, description; no tax yet. */
async function completeProduct(options: { taxApproved?: boolean } = {}) {
  const product = await db.product.create({
    data: {
      name: "Publication product " + seq++,
      slug: "publication-" + randomUUID().slice(0, 8),
      brandId,
      categoryId,
      type: "disposable",
      puffCount: 6000,
      basePriceFils: 4900n,
      description: "A complete synthetic description for publishing.",
      ...(options.taxApproved ? { taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 } : {}),
    },
  });
  await db.variant.create({
    data: {
      productId: product.id,
      sku: "PUB-" + randomUUID().slice(0, 8).toUpperCase(),
      active: true,
      isDefault: true,
    },
  });
  const assetId = randomUUID();
  const keys = Object.fromEntries(
    ["large", "medium", "thumb"].map((n) => [n, `products/${product.id}/${assetId}/${n}.webp`]),
  );
  await pool.query(
    `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
       declared_bytes, state, observed_bytes, width, height, sha256, derivative_keys,
       upload_expires_at)
     VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'ready', 10, 1200, 1200,
       repeat('a', 64), $4::jsonb, statement_timestamp())`,
    [assetId, product.id, staffId, JSON.stringify(keys)],
  );
  await attachGalleryImage(db, { actorId: staffId, requestId: randomUUID() }, product.id, {
    mediaAssetId: assetId,
  });
  return { id: product.id, assetId, keys };
}

describe("product publication, trash/restore and purge (real API and PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    ownerId = (await user("owner")).id;
    const owner = await db.staffUser.findUniqueOrThrow({ where: { id: ownerId } });
    const staff = await user("staff");
    staffId = staff.id;
    brandId = (await db.brand.create({ data: { name: "Pub brand", slug: "pub-brand" } })).id;
    categoryId = (
      await db.category.create({ data: { name: "Pub category", slug: "pub-category" } })
    ).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cookies.owner = await login(owner.email);
    cookies.staff = await login(staff.email);
  });
  afterAll(async () => {
    storage.destroy();
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("needs no tax treatment: the entered price is final (BI-02)", async () => {
    const product = await completeProduct();
    expect(await readiness(product.id)).toMatchObject({
      ready: true,
      status: "draft",
      missing: [],
    });
    const response = await call(`/${product.id}/publish`, "POST", {
      version: await version(product.id),
    });
    expect(response.status).toBe(200);
    const row = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row).toMatchObject({ status: "published", taxTreatmentRef: null });
  });

  it("lists every missing requirement", async () => {
    const bare = await db.product.create({
      data: {
        name: "Bare " + seq++,
        slug: "bare-" + randomUUID().slice(0, 8),
        brandId,
        categoryId,
        type: "disposable",
        basePriceFils: 0n,
      },
    });
    expect((await readiness(bare.id)).missing.sort()).toEqual(
      ["active_variant", "default_variant", "description", "image", "price", "puff_count"].sort(),
    );
  });

  it("lets Staff publish and move to draft once ready; zero stock does not block", async () => {
    const product = await completeProduct({ taxApproved: true });
    expect((await readiness(product.id)).ready).toBe(true);
    const published = await call(`/${product.id}/publish`, "POST", {
      version: await version(product.id),
    });
    expect(published.status).toBe(200);
    expect(((await published.json()) as ProductReadiness).status).toBe("published");
    // Publishing again is a no-op; a stale version conflicts.
    expect(
      (await call(`/${product.id}/publish`, "POST", { version: await version(product.id) })).status,
    ).toBe(200);
    expect(await code(await call(`/${product.id}/unpublish`, "POST", { version: 1 }))).toBe(
      "VERSION_CONFLICT",
    );
    const draft = await call(`/${product.id}/unpublish`, "POST", {
      version: await version(product.id),
    });
    expect(((await draft.json()) as ProductReadiness).status).toBe("draft");
    const actions = (
      await db.auditLog.findMany({ where: { entityId: product.id }, orderBy: { id: "asc" } })
    )
      .map((a) => a.action)
      .filter((a) => a.startsWith("catalog.product_"));
    expect(actions).toEqual(["catalog.product_published", "catalog.product_unpublished"]);
  });

  it("never publishes without an image, even when the last image is removed concurrently", async () => {
    for (let round = 0; round < 5; round++) {
      const product = await completeProduct({ taxApproved: true });
      const image = await db.productImage.findFirstOrThrow({ where: { productId: product.id } });
      await Promise.allSettled([
        changeProductState(
          db,
          { actorId: staffId, requestId: randomUUID() },
          product.id,
          "publish",
          {
            version: await version(product.id),
          },
        ),
        removeGalleryImage(
          db,
          { actorId: staffId, requestId: randomUUID() },
          product.id,
          image.id,
          {
            version: image.version,
          },
        ),
      ]);
      const after = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      const images = await db.productImage.count({ where: { productId: product.id } });
      expect(after.status === "published" && images === 0).toBe(false);
    }
  });

  it("keeps published products publishable: edits that would break readiness are refused", async () => {
    const product = await completeProduct({ taxApproved: true });
    await call(`/${product.id}/publish`, "POST", { version: await version(product.id) });
    const image = await db.productImage.findFirstOrThrow({ where: { productId: product.id } });
    expect(
      await code(
        await call(`/${product.id}/images/${image.id}/remove`, "POST", { version: image.version }),
      ),
    ).toBe("PUBLISH_REQUIREMENTS");
    const variants = (await (await call(`/${product.id}/variants`)).json()) as {
      variants: Array<{ id: string; version: number; sku: string }>;
    };
    const only = variants.variants[0]!;
    // The only variant is the default, which cannot be deactivated anyway; add a second, then try
    // to deactivate it after moving the default — the product must keep an active default.
    expect(
      (
        await call(`/${product.id}/variants/${only.id}`, "PATCH", {
          version: only.version,
          sku: only.sku,
          priceOverrideFils: null,
          lowStockThreshold: 0,
          active: false,
          isDefault: true,
        })
      ).status,
    ).toBe(409);
    const current = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    const edit = await call(`/${product.id}`, "PATCH", {
      version: current.version,
      type: "disposable",
      name: current.name,
      slug: current.slug,
      brandId,
      categoryId,
      puffCount: 6000,
      basePriceFils: 4900,
      compareAtPriceFils: null,
      description: "Too short",
      isNew: false,
      specs: { extra: [] },
    });
    expect(await code(edit)).toBe("PUBLISH_REQUIREMENTS");
    expect(await db.productImage.count({ where: { productId: product.id } })).toBe(1);
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).description).toBe(
      current.description,
    );
  });

  it("publishes once under concurrency, with audit and an event per real change", async () => {
    const product = await completeProduct({ taxApproved: true });
    const v = await version(product.id);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        changeProductState(
          db,
          { actorId: staffId, requestId: randomUUID() },
          product.id,
          "publish",
          {
            version: v,
          },
        ),
      ),
    );
    // One publishes; the others either see the no-op or a version conflict.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const audit = await db.auditLog.count({
      where: { entityId: product.id, action: "catalog.product_published" },
    });
    expect(audit).toBe(1);
    const events = await db.outboxEvent.findMany({
      where: { aggregateId: product.id, eventType: "catalog.changed" },
    });
    expect(events.length).toBeGreaterThanOrEqual(2); // attach + publish
  });

  it("counts a zero-priced active variant as a missing price", async () => {
    const product = await completeProduct({ taxApproved: true });
    await db.variant.updateMany({
      where: { productId: product.id },
      data: { priceOverrideFils: 0n },
    });
    expect((await readiness(product.id)).missing).toEqual(["price"]);
  });

  it("refuses the purge function itself for live products, even outside the API", async () => {
    const product = await completeProduct();
    await expect(
      pool.query("SELECT * FROM catalogue_purge_product($1)", [product.id]),
    ).rejects.toMatchObject({ code: "IH003" });
    expect(await db.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it("trashes (taking published products off the store) and restores as a draft", async () => {
    const product = await completeProduct({ taxApproved: true });
    await call(`/${product.id}/publish`, "POST", { version: await version(product.id) });
    const trashed = await call(`/${product.id}/trash`, "POST", {
      version: await version(product.id),
    });
    expect(trashed.status).toBe(200);
    const row = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.status).toBe("draft");
    expect(row.deletedAt).not.toBeNull();
    expect(await code(await call(`/${product.id}/publish`, "POST", { version: row.version }))).toBe(
      "TRASHED",
    );
    expect(await code(await call(`/${product.id}/trash`, "POST", { version: row.version }))).toBe(
      "TRASHED",
    );
    const list = (await (await call("?status=trashed&limit=100")).json()) as {
      items: Array<{ id: string; trashedAt: string | null }>;
    };
    expect(list.items.find((i) => i.id === product.id)?.trashedAt).not.toBeNull();
    const restored = await call(`/${product.id}/restore`, "POST", { version: row.version });
    expect(((await restored.json()) as ProductReadiness).status).toBe("draft");
    expect(
      await code(
        await call(`/${product.id}/restore`, "POST", { version: await version(product.id) }),
      ),
    ).toBe("NOT_TRASHED");
  });

  it("purges only trashed products without history, Owner-only, removing storage objects", async () => {
    const product = await completeProduct();
    for (const key of Object.values(product.keys))
      await storage.put("media", key, new Uint8Array(8), "image/webp");
    await storage.put("quarantine", "uploads/" + product.assetId, new Uint8Array(8), "image/jpeg");
    expect(
      await code(
        await call(
          `/${product.id}/purge`,
          "POST",
          { version: await version(product.id) },
          cookies.owner,
        ),
      ),
    ).toBe("NOT_TRASHED");
    await call(`/${product.id}/trash`, "POST", { version: await version(product.id) });
    // Staff may trash but never purge.
    expect(
      (await call(`/${product.id}/purge`, "POST", { version: await version(product.id) })).status,
    ).toBe(403);
    const purged = await call(
      `/${product.id}/purge`,
      "POST",
      { version: await version(product.id) },
      cookies.owner,
    );
    expect(purged.status).toBe(200);
    expect(await purged.json()).toMatchObject({
      purged: true,
      storageObjects: 4,
      failedDeletes: 0,
    });
    expect(await db.product.findUnique({ where: { id: product.id } })).toBeNull();
    expect(await db.variant.count({ where: { productId: product.id } })).toBe(0);
    expect(await db.mediaAsset.count({ where: { productId: product.id } })).toBe(0);
    for (const key of Object.values(product.keys))
      expect(await storage.head("media", key)).toBeNull();
    expect(await storage.head("quarantine", "uploads/" + product.assetId)).toBeNull();
    const audit = await db.auditLog.findMany({
      where: { entityId: product.id, action: "catalog.product_purged" },
    });
    expect(audit).toHaveLength(1);
  });

  it("keeps history: a product with stock movements cannot be purged", async () => {
    const product = await completeProduct();
    const variant = await db.variant.findFirstOrThrow({ where: { productId: product.id } });
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 3, 3, 'INITIAL_STOCK', $2)",
      [variant.id, randomUUID()],
    );
    await call(`/${product.id}/trash`, "POST", { version: await version(product.id) });
    expect(
      await code(
        await call(
          `/${product.id}/purge`,
          "POST",
          { version: await version(product.id) },
          cookies.owner,
        ),
      ),
    ).toBe("IN_USE");
    expect(await db.product.findUnique({ where: { id: product.id } })).not.toBeNull();
    expect(await db.stockMovement.count({ where: { variantId: variant.id } })).toBe(1);
    // The runtime path cannot bypass the function: direct deletes stay refused for products.
  });

  it("requires the publish and trash permissions", async () => {
    const product = await completeProduct({ taxApproved: true });
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    for (const key of ["catalog.publish", "catalog.trash"]) {
      const permission = await db.permission.findUniqueOrThrow({ where: { key } });
      const grant = { roleId: role.id, permissionId: permission.id };
      await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
      try {
        const path = key === "catalog.publish" ? "publish" : "trash";
        expect(
          (await call(`/${product.id}/${path}`, "POST", { version: await version(product.id) }))
            .status,
        ).toBe(403);
      } finally {
        await db.rolePermission.create({ data: grant });
      }
    }
    expect((await call(`/${randomUUID()}/readiness`)).status).toBe(404);
    expect((await call(`/${product.id}/readiness`, "GET", undefined, "")).status).toBe(401);
  });
});
