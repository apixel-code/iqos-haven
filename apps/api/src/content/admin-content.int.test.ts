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
  adminContentResponseSchema,
  adminContentSectionSchema,
  contentImagesResponseSchema,
  contentPreviewResponseSchema,
  errorEnvelopeSchema,
  mediaUploadResponseSchema,
  type MediaUploadResponse,
} from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
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
  applicationName: "ih-admin-content-test",
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
let staff = "";
let ownerId = "";
let host = 10;
const keys: string[] = [];
const call = (path: string, method = "GET", body?: unknown, cookie = owner) =>
  fetch(`${base}/v1/admin/content${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const envelope = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const hero = (extra: Record<string, unknown> = {}) => ({
  eyebrow: null,
  title: "Every brand, one place",
  subtitle: "Delivered across the UAE",
  cta: { label: "Shop now", link: { kind: "shop" } },
  image: null,
  ...extra,
});

/** A product a shopper can see. */
async function visibleProduct() {
  const { variantId } = await seedOrder(pool);
  const product = await one<{ id: string; name: string; brandId: string; categoryId: string }>(
    `SELECT p.id, p.name, p.brand_id AS "brandId", p.category_id AS "categoryId"
     FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=$1`,
    [variantId],
  );
  await pool.query("UPDATE brands SET active=true WHERE id=$1", [product.brandId]);
  await pool.query("UPDATE categories SET active=true WHERE id=$1", [product.categoryId]);
  await pool.query("UPDATE products SET status='published' WHERE id=$1", [product.id]);
  return product;
}

describe("storefront content editor API (real API, PostgreSQL and MinIO)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff") => {
      const email = `content-${key}@iqoshaven.test`;
      const user = await db.staffUser.create({
        data: {
          email,
          name: "Content " + key,
          roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
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
    const o = await login("owner");
    owner = o.cookie;
    ownerId = o.id;
    staff = (await login("staff")).cookie;
  });
  afterAll(async () => {
    for (const key of keys) await storage.delete("quarantine", key).catch(() => undefined);
    storage.destroy();
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("is Owner-only and refuses bad input", async () => {
    for (const [path, method, body] of [
      ["", "GET", undefined],
      ["/hero/preview", "GET", undefined],
      ["/images", "GET", undefined],
      ["/hero/draft", "PUT", { expectedVersion: 0, content: hero() }],
      ["/hero/publish", "POST", { expectedVersion: 1 }],
      ["/images/uploads", "POST", { contentType: "image/png", bytes: 100 }],
    ] as const)
      expect((await call(path, method, body, staff)).status, `${method} ${path}`).toBe(403);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    const foreign = await fetch(`${base}/v1/admin/content/hero/draft`, {
      method: "PUT",
      headers: {
        cookie: owner,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedVersion: 0, content: hero() }),
    });
    expect(foreign.status).toBe(403);
    for (const [path, body] of [
      ["/footer/draft", { expectedVersion: 0, content: hero() }],
      ["/hero/draft", { expectedVersion: 0, content: hero({ title: "<script>x</script>" }) }],
      ["/hero/draft", { expectedVersion: 0, content: hero({ html: "<p>x</p>" }) }],
      [
        "/hero/draft",
        {
          expectedVersion: 0,
          content: hero({
            cta: { label: "Go", link: { kind: "url", href: "https://evil.example" } },
          }),
        },
      ],
      ["/hero/draft", { expectedVersion: -1, content: hero() }],
      ["/hero/draft", { expectedVersion: 0, content: hero(), status: "published" }],
    ] as const) {
      const response = await call(path, "PUT", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const invalid = await envelope(
      await call("/hero/draft", "PUT", { expectedVersion: 0, content: hero({ title: "" }) }),
    );
    expect(invalid.fields).toEqual([{ path: "content.title", message: "Invalid field" }]);
    expect(await one("SELECT count(*)::int AS n FROM content_sections")).toEqual({ n: 0 });
  });

  it("lists all seven sections, saves by version and publishes separately", async () => {
    const list = adminContentResponseSchema.parse(await (await call("")).json());
    expect(list.sections.map((section) => [section.key, section.version, section.draft])).toEqual([
      ["ticker", 0, null],
      ["hero", 0, null],
      ["featured", 0, null],
      ["best_sellers", 0, null],
      ["brands", 0, null],
      ["campaign_banner", 0, null],
      ["offers", 0, null],
    ]);
    const saved = await call("/hero/draft", "PUT", { expectedVersion: 0, content: hero() });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(adminContentSectionSchema.parse(await saved.json())).toMatchObject({
      key: "hero",
      version: 1,
      published: null,
      unpublishedChanges: true,
    });
    expect(
      (await envelope(await call("/hero/draft", "PUT", { expectedVersion: 0, content: hero() })))
        .code,
    ).toBe("VERSION_CONFLICT");
    const published = await call("/hero/publish", "POST", { expectedVersion: 1 });
    expect(published.status).toBe(200);
    expect(adminContentSectionSchema.parse(await published.json())).toMatchObject({
      version: 2,
      unpublishedChanges: false,
      published: hero(),
    });
    expect((await envelope(await call("/hero/publish", "POST", { expectedVersion: 2 }))).code).toBe(
      "NOTHING_TO_PUBLISH",
    );
    expect((await call("/offers/publish", "POST", { expectedVersion: 1 })).status).toBe(404);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "content.published" },
      include: { effects: true },
    });
    expect(event.effects.map((effect) => effect.consumer)).toEqual(["storefront_revalidate"]);
  });

  it("previews references and refuses to publish what a shopper cannot see", async () => {
    const shown = await visibleProduct();
    const draftOnly = await visibleProduct();
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [draftOnly.id]);
    expect(
      (
        await call("/featured/draft", "PUT", {
          expectedVersion: 0,
          content: { productIds: [shown.id, draftOnly.id] },
        })
      ).status,
    ).toBe(200);
    const preview = contentPreviewResponseSchema.parse(
      await (await call("/featured/preview")).json(),
    );
    expect(preview.products.map((product) => [product.id, product.visible])).toEqual([
      [shown.id, true],
      [draftOnly.id, false],
    ]);
    expect(preview.products[0]!.priceFromFils).toBe(5000);
    expect(preview.problems).toEqual([
      { kind: "product", id: draftOnly.id, reason: "not_visible" },
    ]);
    const refused = await call("/featured/publish", "POST", { expectedVersion: 1 });
    expect(refused.status).toBe(409);
    const error = await envelope(refused);
    expect(error.code).toBe("CONTENT_REFERENCES");
    expect(error.fields).toEqual([{ path: `product:${draftOnly.id}`, message: "not_visible" }]);
    expect((await call("/campaign_banner/preview")).status).toBe(404);
  });

  it("uploads a content image that belongs to no product and only content routes can finish it", async () => {
    const response = await call("/images/uploads", "POST", { contentType: "image/png", bytes: 64 });
    expect(response.status).toBe(201);
    const grant = mediaUploadResponseSchema.parse(await response.json()) as MediaUploadResponse;
    keys.push("uploads/" + grant.asset.id);
    expect(grant.asset.productId).toBeNull();
    const form = new FormData();
    for (const [name, value] of Object.entries(grant.upload.fields)) form.append(name, value);
    form.append("file", new Blob([new Uint8Array(64)], { type: "image/png" }));
    expect((await fetch(grant.upload.url, { method: "POST", body: form })).status).toBeLessThan(
      300,
    );
    // The product media route does not know content images.
    const productRoute = await fetch(`${base}/v1/admin/media/${grant.asset.id}/complete`, {
      method: "POST",
      headers: { cookie: owner, origin: ADMIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(productRoute.status).toBe(404);
    const completed = await call(`/images/${grant.asset.id}/complete`, "POST", {});
    expect(completed.status).toBe(200);
    expect(
      await one("SELECT purpose, state, product_id FROM media_assets WHERE id=$1", [
        grant.asset.id,
      ]),
    ).toEqual({
      purpose: "content",
      state: "uploaded",
      product_id: null,
    });
    expect(
      await db.outboxEvent.count({
        where: { eventType: "media.uploaded", aggregateId: grant.asset.id },
      }),
    ).toBe(1);
    const images = contentImagesResponseSchema.parse(await (await call("/images")).json());
    expect(images.items[0]).toMatchObject({ id: grant.asset.id, state: "uploaded", url: null });
    // An image that is not processed blocks publishing a hero that uses it.
    expect(
      (
        await call("/hero/draft", "PUT", {
          expectedVersion: 2,
          content: hero({ image: { assetId: grant.asset.id, alt: "A hero" } }),
        })
      ).status,
    ).toBe(200);
    const error = await envelope(await call("/hero/publish", "POST", { expectedVersion: 3 }));
    expect(error).toMatchObject({
      code: "CONTENT_REFERENCES",
      fields: [{ path: `image:${grant.asset.id}`, message: "not_ready" }],
    });
    // And the content route does not know product images.
    const productAsset = await one<{ id: string }>(
      `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, upload_expires_at)
       SELECT g, (SELECT id FROM products LIMIT 1), $1, 'uploads/' || g, 'image/png', 64,
         now() + interval '1 hour' FROM (SELECT gen_random_uuid() AS g) x RETURNING id`,
      [ownerId],
    );
    expect((await call(`/images/${productAsset.id}/complete`, "POST", {})).status).toBe(404);
    // Too many open uploads at once are refused.
    const statuses: number[] = [];
    for (let n = 0; n < 10; n += 1) {
      const next = await call("/images/uploads", "POST", { contentType: "image/png", bytes: 64 });
      statuses.push(next.status);
      if (next.status === 201)
        keys.push("uploads/" + ((await next.json()) as MediaUploadResponse).asset.id);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(9);
    expect(statuses.at(-1)).toBe(409);
    expect(ownerId).not.toBe("");
  });
});
