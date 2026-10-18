import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  AGE_VERIFICATION_REQUIRED,
  storeCartLinesResponseSchema,
  storeProductCardsResponseSchema,
  storeProductResponseSchema,
  storeProductsResponseSchema,
  type StoreBrandsResponse,
  type StoreCartLinesResponse,
  type StoreCategoriesResponse,
  type StoreDeliveryResponse,
  type StoreInfoResponse,
  type StoreProductCardsResponse,
  type StoreProductResponse,
  type StoreProductsResponse,
} from "@ih/contracts";
import { adjustStock, attachGalleryImage, createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import {
  AGE_COOKIE,
  Argon2PasswordHasher,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CatalogueCacheService } from "../cache/catalogue-cache.service";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-store-catalog-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "store-test-1";
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
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
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
});
const cookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base: string;
let cache: CatalogueCacheService;
let staffId = "";
let ip = 10;
/** A fresh client address per call keeps the per-address limiter out of unrelated tests. */
const get = (path: string, headers: Record<string, string> = { cookie }) =>
  fetch(`${base}/v1/store${path}`, {
    headers: { "x-ih-client-ip": `198.51.100.${(ip = (ip % 250) + 1)}`, ...headers },
  });
const json = async <T>(path: string) => {
  const response = await get(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
};
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

const unique = () => randomUUID().slice(0, 8);
async function parent(kind: "brand" | "category", name: string, overrides: object = {}) {
  const data = { name, slug: `${kind}-${unique()}`, active: true, ...overrides };
  return kind === "brand" ? db.brand.create({ data }) : db.category.create({ data });
}
interface Seed {
  name?: string;
  status?: "draft" | "published";
  brandId: string;
  categoryId: string;
  type?: "disposable" | "kit";
  basePriceFils?: number;
  compareAtPriceFils?: number | null;
  /** [attributes, priceOverrideFils | null, stock, active] per variant; the first is the default. */
  variants?: Array<[Record<string, string>, number | null, number, boolean]>;
  images?: number;
}
async function product(seed: Seed) {
  const published = (seed.status ?? "published") === "published";
  const row = await db.product.create({
    data: {
      name: seed.name ?? "Product " + unique(),
      slug: "product-" + unique(),
      brandId: seed.brandId,
      categoryId: seed.categoryId,
      type: seed.type ?? "disposable",
      puffCount: (seed.type ?? "disposable") === "disposable" ? 7000 : null,
      basePriceFils: BigInt(seed.basePriceFils ?? 4900),
      compareAtPriceFils: seed.compareAtPriceFils == null ? null : BigInt(seed.compareAtPriceFils),
      description: "Synthetic description.",
      specs: { extra: [] },
      seo: { title: "Synthetic SEO title", description: null },
    },
  });
  const variants = [];
  for (const [index, [attributes, price, stock, active]] of (
    seed.variants ?? [[{}, null, 5, true]]
  ).entries()) {
    const variant = await db.variant.create({
      data: {
        productId: row.id,
        sku: "STORE-" + unique().toUpperCase(),
        attributes,
        priceOverrideFils: price === null ? null : BigInt(price),
        active,
        isDefault: index === 0,
      },
    });
    if (stock > 0)
      await adjustStock(db, { actorId: staffId, requestId: randomUUID() }, variant.id, {
        commandId: randomUUID(),
        delta: stock,
        reason: "RESTOCK",
      });
    variants.push(variant);
  }
  const assets: string[] = [];
  for (let index = 0; index < (seed.images ?? 0); index++) {
    const assetId = randomUUID();
    const keys = Object.fromEntries(
      ["large", "medium", "thumb"].map((n) => [n, `products/${row.id}/${assetId}/${n}.webp`]),
    );
    await pool.query(
      `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, state, observed_bytes, width, height, sha256, derivative_keys,
         upload_expires_at)
       VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'ready', 10, 1200, 900,
         repeat('a', 64), $4::jsonb, statement_timestamp())`,
      [assetId, row.id, staffId, JSON.stringify(keys)],
    );
    await attachGalleryImage(db, { actorId: staffId, requestId: randomUUID() }, row.id, {
      mediaAssetId: assetId,
    });
    assets.push(assetId);
  }
  if (published)
    await db.product.update({
      where: { id: row.id },
      data: { status: "published", taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 },
    });
  return { ...row, variants, assets };
}
/** Walks every page of a listing. */
async function all(query: string, limit = 2) {
  const items: StoreProductsResponse["items"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const result: StoreProductsResponse = await json(
      `/products?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(storeProductsResponseSchema.safeParse(result).success).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(limit);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not end");
}

describe("gated store catalogue reads (real API, PostgreSQL, Ed25519 ticket)", () => {
  let brand: Awaited<ReturnType<typeof parent>>;
  let category: Awaited<ReturnType<typeof parent>>;

  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "store@iqoshaven.test",
          name: "Seeder",
          roleId: role.id,
          passwordHash: await new Argon2PasswordHasher({
            memoryKib: 19456,
            timeCost: 2,
            parallelism: 1,
          }).hash("copper-lantern-river-71"),
        },
      })
    ).id;
    brand = await parent("brand", "Orbe");
    category = await parent("category", "Disposables");
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cache = app.get(CatalogueCacheService);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("serves nothing without a valid age ticket, even from a warm cache", async () => {
    const visible = await product({
      brandId: brand.id,
      categoryId: category.id,
      name: "Gate Probe",
    });
    await cache.invalidate();
    const paths = ["/brands", "/categories", "/products", `/products/${visible.slug}`];
    // A verified shopper warms every cache entry first.
    for (const path of paths) expect((await get(path)).status).toBe(200);
    for (const path of paths)
      for (const headers of [
        {},
        { cookie: `${AGE_COOKIE}=accepted` },
        { cookie: cookie.slice(0, -4) + "AAAA" },
        { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
      ] as Array<Record<string, string>>) {
        const response = await get(path, headers);
        const text = await response.text();
        expect(response.status, path).toBe(403);
        expect(JSON.parse(text).error.code).toBe(AGE_VERIFICATION_REQUIRED);
        expect(text).not.toContain("Gate Probe");
        expect(text).not.toContain(visible.slug);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
  });

  it("answers private, no-store and varies on the cookie", async () => {
    const seeded = await product({ brandId: brand.id, categoryId: category.id });
    await cache.invalidate();
    for (const path of ["/brands", "/categories", "/products", `/products/${seeded.slug}`]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toMatch(/cookie/i);
    }
    const missing = await get("/products/no-such-product");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("shows only published products of live, active parents with an active option", async () => {
    const b = await parent("brand", "Visibility brand");
    const c = await parent("category", "Visibility category");
    const hiddenBrand = await parent("brand", "Hidden brand", { active: false });
    const hiddenCategory = await parent("category", "Hidden category", { active: false });
    const shown = await product({ brandId: b.id, categoryId: c.id, name: "Shown" });
    const hidden = [
      await product({ brandId: b.id, categoryId: c.id, name: "Draft", status: "draft" }),
      await product({ brandId: hiddenBrand.id, categoryId: c.id, name: "Inactive brand" }),
      await product({ brandId: b.id, categoryId: hiddenCategory.id, name: "Inactive category" }),
      await product({
        brandId: b.id,
        categoryId: c.id,
        name: "No active option",
        status: "draft",
        variants: [[{}, null, 3, false]],
      }),
    ];
    // Trashed: a draft with a deletion mark (trash always moves a product to draft first).
    const trashed = await product({
      brandId: b.id,
      categoryId: c.id,
      name: "Trashed",
      status: "draft",
    });
    await pool.query("UPDATE products SET deleted_at=statement_timestamp() WHERE id=$1", [
      trashed.id,
    ]);
    hidden.push(trashed);
    await cache.invalidate();

    const listed = await all(`brand=${b.slug}`);
    expect(listed.map((item) => item.name)).toEqual(["Shown"]);
    expect((await all(`brand=${hiddenBrand.slug}`)).length).toBe(0);
    expect((await all(`category=${hiddenCategory.slug}`)).length).toBe(0);
    expect((await get(`/products/${shown.slug}`)).status).toBe(200);
    const bodies = new Set<string>();
    for (const row of [...hidden, { slug: "never-existed" }]) {
      const response = await get(`/products/${row.slug}`);
      expect(response.status, row.slug).toBe(404);
      const body = (await response.json()) as { error: { requestId?: string } };
      delete body.error.requestId;
      bodies.add(JSON.stringify(body));
    }
    // Draft, trashed, hidden-parent and unknown products are indistinguishable.
    expect(bodies.size).toBe(1);

    const brands = await json<StoreBrandsResponse>("/brands");
    expect(brands.items.find((item) => item.slug === b.slug)).toMatchObject({ productCount: 1 });
    expect(brands.items.some((item) => item.slug === hiddenBrand.slug)).toBe(false);
    const categories = await json<StoreCategoriesResponse>("/categories");
    expect(categories.items.find((item) => item.slug === c.slug)).toMatchObject({
      productCount: 1,
    });
    expect(categories.items.some((item) => item.slug === hiddenCategory.slug)).toBe(false);
  });

  it("returns exactly the contract: prices in fils, options, availability, no internal fields", async () => {
    const seeded = await product({
      brandId: brand.id,
      categoryId: category.id,
      name: "Halo 7K",
      basePriceFils: 4900,
      compareAtPriceFils: 5900,
      variants: [
        [{ flavour: "grape ice" }, null, 4, true],
        [{ flavour: "mint" }, 4500, 0, true],
        [{ flavour: "peach" }, 6500, 9, true],
        [{ flavour: "retired" }, 1000, 50, false],
      ],
      images: 2,
    });
    await cache.invalidate();
    const response = await get(`/products/${seeded.slug}`);
    const text = await response.text();
    const detail = JSON.parse(text) as StoreProductResponse;
    expect(storeProductResponseSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      slug: seeded.slug,
      name: "Halo 7K",
      type: "disposable",
      brand: { name: "Orbe", slug: brand.slug },
      category: { name: "Disposables", slug: category.slug },
      puffCount: 7000,
      soldOut: false,
      seo: { title: "Synthetic SEO title", description: null },
    });
    // Active options only; the inactive, cheaper one is neither listed nor priced.
    expect(
      detail.variants.map((v) => [
        v.attributes.flavour,
        v.priceFils,
        v.compareAtPriceFils,
        v.available,
      ]),
    ).toEqual([
      ["grape ice", 4900, 5900, true],
      ["mint", 4500, 5900, false],
      ["peach", 6500, null, true],
    ]);
    expect(detail.variants.filter((v) => v.isDefault)).toHaveLength(1);
    for (const secret of [
      ...seeded.variants.map((v) => v.sku),
      "stockOnHand",
      "stock_on_hand",
      "lowStock",
      "taxTreatment",
      "synthetic-vat",
      "version",
      "sku",
      staffId,
      "uploads/",
    ])
      expect(text, secret).not.toContain(secret);

    // Images: signed links to sanitized derivatives in the media bucket, primary first.
    expect(detail.images).toHaveLength(2);
    for (const image of detail.images)
      for (const [name, url] of Object.entries(image.urls)) {
        const parsed = new URL(url);
        // The storage key names the product folder and the asset; nothing else.
        expect(parsed.pathname).toContain(`/products/${seeded.id}/`);
        expect(parsed.pathname.endsWith(`/${name}.webp`)).toBe(true);
        expect(parsed.searchParams.get("X-Amz-Expires")).toBe("600");
        expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true);
        expect(url).not.toContain("quarantine");
      }
    expect(detail.images[0]!.urls.thumb).toContain(seeded.assets[0]!);

    const [card] = (await all(`brand=${brand.slug}`)).filter((item) => item.slug === seeded.slug);
    expect(card).toMatchObject({
      priceFromFils: 4500,
      compareAtPriceFils: 5900,
      variantCount: 3,
      soldOut: false,
    });
    expect(card!.image?.urls.thumb).toContain(seeded.assets[0]!);
  });

  it("keeps a sold-out product listed and marks it, without hiding or swapping options", async () => {
    const b = await parent("brand", "Sold out brand");
    const seeded = await product({
      brandId: b.id,
      categoryId: category.id,
      variants: [
        [{ flavour: "grape" }, null, 0, true],
        [{ flavour: "mint" }, null, 0, true],
        [{ flavour: "hidden" }, null, 20, false],
      ],
    });
    await cache.invalidate();
    const [card] = await all(`brand=${b.slug}`);
    expect(card).toMatchObject({ slug: seeded.slug, soldOut: true, variantCount: 2 });
    const detail = await json<StoreProductResponse>(`/products/${seeded.slug}`);
    expect(detail.soldOut).toBe(true);
    expect(detail.variants.map((v) => v.available)).toEqual([false, false]);
  });

  it("resolves a former slug to the product and reports its current slug", async () => {
    const seeded = await product({ brandId: brand.id, categoryId: category.id });
    const former = "former-" + unique();
    await db.slugRedirect.create({
      data: { entityType: "product", oldSlug: former, productId: seeded.id },
    });
    // A redirect to a hidden product must not reveal it.
    const draft = await product({ brandId: brand.id, categoryId: category.id, status: "draft" });
    const formerDraft = "former-" + unique();
    await db.slugRedirect.create({
      data: { entityType: "product", oldSlug: formerDraft, productId: draft.id },
    });
    await cache.invalidate();
    expect((await json<StoreProductResponse>(`/products/${former}`)).slug).toBe(seeded.slug);
    expect((await get(`/products/${formerDraft}`)).status).toBe(404);
  });

  it("filters and sorts by a fixed list, with stable pages and no duplicates", async () => {
    const b = await parent("brand", "Sort brand");
    const kits = await parent("category", "Kits");
    const seeds: Array<[string, number, "disposable" | "kit", string]> = [
      ["Charlie", 3000, "disposable", category.id],
      ["alpha", 5000, "kit", kits.id],
      ["Bravo", 3000, "disposable", category.id],
      ["delta", 1000, "kit", kits.id],
      ["Echo", 4000, "disposable", category.id],
    ];
    for (const [name, price, type, categoryId] of seeds)
      await product({ brandId: b.id, categoryId, name, type, basePriceFils: price });
    await cache.invalidate();
    const names = async (query: string, limit?: number) =>
      (await all(`brand=${b.slug}&${query}`, limit)).map((item) => item.name);

    expect(await names("sort=name")).toEqual(["alpha", "Bravo", "Charlie", "delta", "Echo"]);
    expect(await names("sort=price_asc")).toEqual(
      // Equal prices fall back to creation order (product ID).
      ["delta", "Charlie", "Bravo", "Echo", "alpha"],
    );
    expect(await names("sort=price_desc")).toEqual(["alpha", "Echo", "Bravo", "Charlie", "delta"]);
    expect(await names("sort=newest")).toEqual(["Echo", "delta", "Bravo", "alpha", "Charlie"]);
    for (const limit of [1, 3, 48])
      expect(await names("sort=newest", limit)).toEqual([
        "Echo",
        "delta",
        "Bravo",
        "alpha",
        "Charlie",
      ]);
    expect(await names("sort=name&type=kit")).toEqual(["alpha", "delta"]);
    expect(await names(`sort=name&category=${kits.slug}`)).toEqual(["alpha", "delta"]);
    expect(await names(`sort=name&category=${category.slug}&type=kit`)).toEqual([]);
    expect(await all("sort=name&brand=no-such-brand")).toEqual([]);
    // A repeated parameter is refused, not resolved by guessing.
    expect((await get(`/products?brand=${b.slug}&brand=no-such-brand`)).status).toBe(400);
  });

  it("bounds and validates every query input", async () => {
    const page = await json<StoreProductsResponse>("/products?limit=1&sort=price_asc");
    const cursorForPrice = page.nextCursor!;
    expect(cursorForPrice).toMatch(/^[A-Za-z0-9_-]+$/);
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const query of [
      "limit=0",
      "limit=49",
      "limit=abc",
      "sort=price",
      "sort=name;DROP TABLE products",
      "type=pod",
      "brand=Not%20A%20Slug",
      "brand=" + "a".repeat(151),
      "category=a'--",
      "q=anything",
      "cursor=" + "A".repeat(401),
      "cursor=not*base64",
      "cursor=" + forged("nope"),
      "cursor=" + forged(["newest", "x", "not-a-uuid"]),
      "cursor=" + forged(["price_asc", "1; DROP", randomUUID()]),
      // Values no column can hold must be refused, not sent to the database.
      "sort=price_asc&cursor=" + forged(["price_asc", 3_000_000_000, randomUUID()]),
      "sort=price_desc&cursor=" + forged(["price_desc", 1.5, randomUUID()]),
      "sort=price_asc&cursor=" + forged(["price_asc", -1, randomUUID()]),
      "sort=name&cursor=" + forged(["name", "a\u0000b", randomUUID()]),
      "sort=name&cursor=" + forged(["name", "x".repeat(201), randomUUID()]),
      // A cursor issued for one sort is refused for another.
      `sort=name&cursor=${cursorForPrice}`,
      `cursor=${cursorForPrice}`,
    ]) {
      const response = await get(`/products?${query}`);
      expect(response.status, query).toBe(400);
      expect(await errorCode(response), query).toBe("VALIDATION_ERROR");
    }
    for (const slug of ["UPPER", "a b", "..%2F..%2Fetc", "x'--"])
      expect((await get(`/products/${slug}`)).status, slug).toBe(400);
    // Over-long path segments are refused by the router before validation.
    expect([400, 414]).toContain((await get(`/products/${"a".repeat(151)}`)).status);
    // Still alive and unharmed afterwards.
    expect((await db.product.count()) > 0).toBe(true);
  });

  it("serves from the cache until the catalogue is invalidated", async () => {
    const b = await parent("brand", "Cache brand");
    const seeded = await product({ brandId: b.id, categoryId: category.id, name: "Before" });
    await cache.invalidate();
    const path = `/products/${seeded.slug}`;
    expect((await json<StoreProductResponse>(path)).name).toBe("Before");
    expect((await all(`brand=${b.slug}`))[0]!.name).toBe("Before");
    // A change the cache has not been told about yet (the admin API tells it after commit).
    await pool.query("UPDATE products SET name='After' WHERE id=$1", [seeded.id]);
    expect((await json<StoreProductResponse>(path)).name).toBe("Before");
    await cache.invalidate();
    expect((await json<StoreProductResponse>(path)).name).toBe("After");
    expect((await all(`brand=${b.slug}`))[0]!.name).toBe("After");
    // Unpublishing takes it off the store at the next invalidation.
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [seeded.id]);
    await cache.invalidate();
    expect((await get(path)).status).toBe(404);
    expect(await all(`brand=${b.slug}`)).toEqual([]);
  });

  it("does not let unknown slugs or forged cursors fill the cache or fail the request", async () => {
    await cache.invalidate();
    const before = cache.stats().entries;
    for (let attempt = 0; attempt < 30; attempt++)
      expect((await get(`/products/unknown-${unique()}`)).status).toBe(404);
    const wellFormed = (name: string) =>
      Buffer.from(JSON.stringify(["name", name, randomUUID()])).toString("base64url");
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await get(`/products?sort=name&cursor=${wellFormed("zz" + attempt)}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as StoreProductsResponse).items).toEqual([]);
    }
    expect(cache.stats().entries).toBe(before);
    // A product published after being asked for is visible at once: its miss was never stored.
    const b = await parent("brand", "Late brand");
    const late = await product({ brandId: b.id, categoryId: category.id, status: "draft" });
    expect((await get(`/products/${late.slug}`)).status).toBe(404);
    await db.product.update({
      where: { id: late.id },
      data: { status: "published", taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 },
    });
    expect((await get(`/products/${late.slug}`)).status).toBe(200);
  });

  it("shows no specifications, instead of failing, when stored specs do not fit the contract", async () => {
    const seeded = await product({ brandId: brand.id, categoryId: category.id });
    await pool.query(`UPDATE products SET specs='{"unexpected":true}'::jsonb WHERE id=$1`, [
      seeded.id,
    ]);
    await cache.invalidate();
    expect((await json<StoreProductResponse>(`/products/${seeded.slug}`)).specs).toEqual({
      extra: [],
    });
  });

  it("refreshes device-cart variants: current price and stock, hidden ones simply absent", async () => {
    const b = await parent("brand", "Cart brand");
    const seeded = await product({
      brandId: b.id,
      categoryId: category.id,
      name: "Cart Product",
      basePriceFils: 4900,
      compareAtPriceFils: 5900,
      variants: [
        [{ flavour: "grape ice", nicotine: "20 mg" }, null, 3, true],
        [{ flavour: "mint", nicotine: "50 mg" }, 4500, 0, true],
        [{ flavour: "retired", nicotine: "20 mg" }, null, 9, false],
      ],
      images: 1,
    });
    await db.productOption.createMany({
      data: [
        { productId: seeded.id, name: "nicotine", allowedValues: ["20 mg", "50 mg"], sortOrder: 1 },
        {
          productId: seeded.id,
          name: "flavour",
          allowedValues: ["grape ice", "mint"],
          sortOrder: 0,
        },
      ],
    });
    const draft = await product({ brandId: b.id, categoryId: category.id, status: "draft" });
    const [grape, mint, retired] = seeded.variants;
    const lines = async (ids: string[]) => {
      const response = await get(`/cart/lines?${ids.map((id) => `variant=${id}`).join("&")}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const text = await response.text();
      return { text, body: JSON.parse(text) as StoreCartLinesResponse };
    };
    const { text, body } = await lines([
      mint!.id,
      grape!.id,
      retired!.id,
      draft.variants[0]!.id,
      randomUUID(),
      grape!.id,
    ]);
    expect(storeCartLinesResponseSchema.safeParse(body).success).toBe(true);
    const byId = new Map(body.lines.map((line) => [line.variantId, line]));
    // Inactive, draft and unknown variants are absent; a repeated ID appears once.
    expect([...byId.keys()].sort()).toEqual([grape!.id, mint!.id].sort());
    expect(byId.get(grape!.id)).toMatchObject({
      productSlug: seeded.slug,
      name: "Cart Product",
      brand: "Cart brand",
      options: "grape ice · 20 mg",
      priceFils: 4900,
      compareAtPriceFils: 5900,
      available: true,
    });
    expect(byId.get(mint!.id)).toMatchObject({
      options: "mint · 50 mg",
      priceFils: 4500,
      available: false,
    });
    expect(byId.get(grape!.id)!.image?.urls.thumb).toContain(seeded.assets[0]!);
    for (const secret of [...seeded.variants.map((v) => v.sku), "stock", "sku", "version"])
      expect(text, secret).not.toContain(secret);

    // Not cached: a price change and a deactivation show on the next read.
    await pool.query("UPDATE variants SET price_override_fils=5200 WHERE id=$1", [grape!.id]);
    await pool.query("UPDATE variants SET active=false WHERE id=$1", [mint!.id]);
    const after = await lines([grape!.id, mint!.id]);
    expect(after.body.lines).toHaveLength(1);
    expect(after.body.lines[0]).toMatchObject({ variantId: grape!.id, priceFils: 5200 });
    // Unpublishing the product removes every line.
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [seeded.id]);
    expect((await lines([grape!.id])).body.lines).toEqual([]);

    for (const query of [
      "",
      "variant=not-a-uuid",
      "variant=" + Array.from({ length: 51 }, () => randomUUID()).join("&variant="),
      `variant=${randomUUID()}&other=1`,
    ])
      expect((await get(`/cart/lines?${query}`)).status, query.slice(0, 40)).toBe(400);
    const unverified = await get(`/cart/lines?variant=${grape!.id}`, {});
    expect(unverified.status).toBe(403);
    expect(await unverified.text()).not.toContain("Cart Product");
  });

  it("returns cards for remembered slugs in order, following renames and hiding the rest", async () => {
    const b = await parent("brand", "Saved brand");
    const first = await product({ brandId: b.id, categoryId: category.id, name: "Saved One" });
    const second = await product({
      brandId: b.id,
      categoryId: category.id,
      name: "Saved Two",
      variants: [[{}, null, 0, true]],
    });
    const draft = await product({ brandId: b.id, categoryId: category.id, status: "draft" });
    const former = "saved-former-" + unique();
    await db.slugRedirect.create({
      data: { entityType: "product", oldSlug: former, productId: second.id },
    });
    const formerDraft = "saved-former-" + unique();
    await db.slugRedirect.create({
      data: { entityType: "product", oldSlug: formerDraft, productId: draft.id },
    });
    const query = [former, "never-existed", draft.slug, first.slug, formerDraft, first.slug]
      .map((slug) => `slug=${slug}`)
      .join("&");
    const response = await get(`/product-cards?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as StoreProductCardsResponse;
    expect(storeProductCardsResponseSchema.safeParse(body).success).toBe(true);
    // Asked order kept; the former slug resolves to the current one; hidden slugs are absent.
    expect(body.items.map((item) => [item.requested, item.card.slug, item.card.name])).toEqual([
      [former, second.slug, "Saved Two"],
      [first.slug, first.slug, "Saved One"],
    ]);
    expect(body.items[0]!.card.soldOut).toBe(true);
    // The old and the current slug of one product both resolve to it.
    const both = (await (
      await get(`/product-cards?slug=${former}&slug=${second.slug}`)
    ).json()) as StoreProductCardsResponse;
    expect(both.items.map((item) => [item.requested, item.card.slug])).toEqual([
      [former, second.slug],
      [second.slug, second.slug],
    ]);
    for (const bad of [
      "",
      "slug=Not%20A%20Slug",
      "slug=" + Array.from({ length: 25 }, (_, index) => "s" + index).join("&slug="),
      `slug=${first.slug}&other=1`,
    ])
      expect((await get(`/product-cards?${bad}`)).status, bad.slice(0, 30)).toBe(400);
    const unverified = await get(`/product-cards?slug=${first.slug}`, {});
    expect(unverified.status).toBe(403);
    expect(await unverified.text()).not.toContain("Saved One");
  });

  it("gives the shell only the WhatsApp number and social links, behind the age ticket", async () => {
    await cache.invalidate();
    const noSocial = { instagram: null, tiktok: null, facebook: null };
    expect(await json<StoreInfoResponse>("/info")).toEqual({
      whatsappNumber: null,
      checkoutOpen: false,
      social: noSocial,
    });
    await db.setting.create({
      data: {
        key: "whatsapp",
        updatedBy: staffId,
        value: {
          number: "+971501234567",
          templates: {
            orderConfirmation: "Private template {{order_number}}",
            statusUpdate: null,
            support: null,
          },
        },
      },
    });
    await db.setting.create({
      data: {
        key: "notifications",
        updatedBy: staffId,
        value: {
          inApp: true,
          newOrderEmail: { enabled: true, recipients: ["owner@iqoshaven.test"] },
        },
      },
    });
    // The footer's social links (ADR 0097); the rest of Contact stays private to the admin.
    await db.setting.create({
      data: {
        key: "contact",
        updatedBy: staffId,
        value: {
          email: "private-contact@iqoshaven.test",
          phone: "+971509999999",
          address: "Private address",
          openingHours: null,
          footerNote: null,
          social: {
            instagram: "https://www.instagram.com/iqoshaven",
            tiktok: null,
            facebook: null,
          },
        },
      },
    });
    await cache.invalidate();
    const response = await get("/info");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      whatsappNumber: "+971501234567",
      checkoutOpen: false,
      social: { ...noSocial, instagram: "https://www.instagram.com/iqoshaven" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const secret of [
      "Private template",
      "owner@iqoshaven.test",
      "templates",
      "recipients",
      "private-contact@iqoshaven.test",
      "+971509999999",
      "Private address",
    ])
      expect(text).not.toContain(secret);
    const unverified = await get("/info", {});
    expect(unverified.status).toBe(403);
    expect(await unverified.text()).not.toContain("+971501234567");
    // A value that is not a phone number is treated as not configured.
    await pool.query(
      `UPDATE settings SET value='{"number":"call me"}'::jsonb WHERE key='whatsapp'`,
    );
    // So is a social link that is not https.
    await pool.query(
      `UPDATE settings SET value=jsonb_set(value, '{social,instagram}', '"javascript:alert(1)"') WHERE key='contact'`,
    );
    await cache.invalidate();
    expect(await json<StoreInfoResponse>("/info")).toEqual({
      whatsappNumber: null,
      checkoutOpen: false,
      social: noSocial,
    });
  });

  it("lists active delivery areas and the flat fee for checkout, behind the age ticket", async () => {
    expect(await json<StoreDeliveryResponse>("/delivery")).toEqual({
      feeFils: null,
      etaText: null,
      freeThresholdFils: null,
      areas: [],
    });
    const area = (code: string, name: string, emirate: string, active: boolean) =>
      db.deliveryArea.create({ data: { code, name, emirate, active, updatedBy: staffId } });
    const marina = await area("synthetic_marina", "Synthetic Marina", "dubai", true);
    const corniche = await area("synthetic_corniche", "Synthetic Corniche", "abu_dhabi", true);
    await area("synthetic_closed", "Synthetic Closed", "sharjah", false);
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: staffId,
        value: { flatFeeFils: 1500, etaText: "Synthetic ETA", freeThresholdFils: null },
      },
    });
    const response = await get("/delivery");
    const text = await response.text();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Active areas only, by emirate then name; no code, version or staff field.
    expect(JSON.parse(text)).toEqual({
      feeFils: 1500,
      etaText: "Synthetic ETA",
      freeThresholdFils: null,
      areas: [
        { id: corniche.id, name: "Synthetic Corniche", emirate: "abu_dhabi" },
        { id: marina.id, name: "Synthetic Marina", emirate: "dubai" },
      ],
    });
    for (const hidden of ["Synthetic Closed", "synthetic_marina", "updatedBy", "version"])
      expect(text).not.toContain(hidden);
    // Not cached: switching an area off removes it from the next answer.
    await pool.query("UPDATE delivery_areas SET active=false, version=version+1 WHERE id=$1", [
      marina.id,
    ]);
    expect((await json<StoreDeliveryResponse>("/delivery")).areas.map((item) => item.id)).toEqual([
      corniche.id,
    ]);
    const unverified = await get("/delivery", {});
    expect(unverified.status).toBe(403);
    expect(await unverified.text()).not.toContain("Synthetic Corniche");
  });

  it("limits reads per client address", async () => {
    const headers = { cookie, "x-ih-client-ip": "203.0.113.200" };
    const statuses: number[] = [];
    for (let batch = 0; batch < 5; batch++)
      statuses.push(
        ...(await Promise.all(Array.from({ length: 50 }, () => get("/categories", headers)))).map(
          (response) => response.status,
        ),
      );
    expect(statuses.filter((status) => status === 200)).toHaveLength(240);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
    const limited = await get("/categories", headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toMatch(/no-store/);
    // Another address is unaffected.
    expect((await get("/categories")).status).toBe(200);
  });
});
