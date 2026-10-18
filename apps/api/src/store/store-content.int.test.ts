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
import { storeHomeResponseSchema, type ContentSectionKey } from "@ih/contracts";
import {
  adjustStock,
  createDatabase,
  createPool,
  publishContentSection,
  saveContentDraft,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { AGE_COOKIE, ageTicketPublicKey, ageTicketSigner, signAgeTicket } from "@ih/platform";
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
  applicationName: "ih-store-content-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "store-content-test-1";
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
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
let base = "";
let ownerId = "";
let host = 10;
const as = () => ({ requestId: randomUUID(), actorId: ownerId });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
/** What the worker's `storefront_revalidate` effect does after a publish or catalogue change. */
const revalidate = () => app.get(CatalogueCacheService).invalidate();
const home = async (headers: Record<string, string> = { cookie }) => {
  const response = await fetch(`${base}/v1/store/content/home`, {
    headers: { "x-ih-client-ip": `198.51.100.${(host = (host % 240) + 1)}`, ...headers },
  });
  return response;
};
const homeData = async () => {
  const response = await home();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return storeHomeResponseSchema.parse(await response.json());
};
/** Saves and publishes a section through the storage commands (the admin routes use these). */
async function publish(key: ContentSectionKey, content: unknown) {
  const current = await one<{ version: number } | undefined>(
    "SELECT version FROM content_sections WHERE key=$1",
    [key],
  );
  const saved = await saveContentDraft(db, as(), key, {
    expectedVersion: current?.version ?? 0,
    content,
  });
  await publishContentSection(db, as(), key, saved.version);
}
async function visibleProduct(name: string) {
  const { variantId, orderId } = await seedOrder(pool);
  const product = await one<{ id: string; slug: string; brandId: string; categoryId: string }>(
    `SELECT p.id, p.slug, p.brand_id AS "brandId", p.category_id AS "categoryId"
     FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=$1`,
    [variantId],
  );
  await pool.query("UPDATE brands SET active=true WHERE id=$1", [product.brandId]);
  await pool.query("UPDATE categories SET active=true WHERE id=$1", [product.categoryId]);
  await pool.query("UPDATE products SET status='published', name=$2 WHERE id=$1", [
    product.id,
    name,
  ]);
  return { ...product, variantId, orderId };
}
const stock = (variantId: string, units: number) =>
  adjustStock(db, as(), variantId, {
    commandId: randomUUID(),
    reason: "RESTOCK",
    delta: units,
    note: "test",
  });

describe("published home content through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "home-owner@iqoshaven.test",
          name: "Home Owner",
          roleId: (await db.role.findUniqueOrThrow({ where: { key: "owner" } })).id,
          passwordHash: HASH,
        },
      })
    ).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("answers nothing without a valid age ticket", async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { cookie: `${AGE_COOKIE}=accepted` },
      { "user-agent": "Googlebot/2.1" },
    ]) {
      const response = await home(headers);
      expect(response.status).toBe(403);
    }
  });

  it("shows nothing before anything is published, and never a draft", async () => {
    expect(await homeData()).toEqual({
      ticker: null,
      heroSlides: [],
      featured: [],
      bestSellers: [],
      brands: [],
      banners: [],
      offers: null,
    });
    // A saved draft that was never published stays private.
    await saveContentDraft(db, as(), "ticker", {
      expectedVersion: 0,
      content: { enabled: true, messages: ["Draft only", "Not public"] },
    });
    await revalidate();
    expect((await homeData()).ticker).toBeNull();
    await publishContentSection(db, as(), "ticker", 1);
    await revalidate();
    expect((await homeData()).ticker).toEqual({ messages: ["Draft only", "Not public"] });
    // A newer draft does not replace what is published.
    await saveContentDraft(db, as(), "ticker", {
      expectedVersion: 2,
      content: { enabled: true, messages: ["Unpublished change", "Still private"] },
    });
    await revalidate();
    const text = JSON.stringify(await homeData());
    expect(text).toContain("Draft only");
    expect(text).not.toContain("Unpublished change");
  });

  it("assembles every section with valid references only, and drops what is no longer visible", async () => {
    const halo = await visibleProduct("Halo Home");
    const kit = await visibleProduct("Kit Home");
    await stock(halo.variantId, 5);
    await publish("hero", {
      slides: [
        {
          style: "navy",
          eyebrow: "New",
          title: "Every brand, one place",
          subtitle: null,
          cta: { label: "Shop the brand", link: { kind: "brand", brandId: halo.brandId } },
          secondaryCta: { label: "All products", link: { kind: "shop" } },
          image: null,
        },
        {
          style: "lilac",
          eyebrow: null,
          title: "Pod kits for every day",
          subtitle: "Refillable and easy to carry",
          cta: { label: "See the kit", link: { kind: "product", productId: kit.id } },
          secondaryCta: null,
          image: null,
        },
      ],
    });
    await publish("featured", { productIds: [kit.id, halo.id] });
    await publish("brands", { brandIds: [halo.brandId, kit.brandId] });
    await publish("campaign_banner", {
      banners: [
        {
          enabled: true,
          title: "Pod kits",
          subtitle: null,
          cta: { label: "See it", link: { kind: "product", productId: kit.id } },
          image: null,
        },
        { enabled: false, title: "Hidden banner", subtitle: null, cta: null, image: null },
      ],
    });
    await publish("offers", { enabled: true, title: "This week", productIds: [halo.id] });
    await revalidate();
    const page = await homeData();
    const brandSlug = (
      await one<{ slug: string }>("SELECT slug FROM brands WHERE id=$1", [halo.brandId])
    ).slug;
    expect(page.heroSlides).toEqual([
      {
        style: "navy",
        eyebrow: "New",
        title: "Every brand, one place",
        subtitle: null,
        cta: { label: "Shop the brand", href: `/brands/${brandSlug}` },
        secondaryCta: { label: "All products", href: "/shop" },
        image: null,
      },
      {
        style: "lilac",
        eyebrow: null,
        title: "Pod kits for every day",
        subtitle: "Refillable and easy to carry",
        cta: { label: "See the kit", href: `/p/${kit.slug}` },
        secondaryCta: null,
        image: null,
      },
    ]);
    expect(page.featured.map((card) => card.name)).toEqual(["Kit Home", "Halo Home"]);
    expect(page.brands.map((brand) => brand.slug)).toHaveLength(2);
    expect(page.banners).toEqual([
      {
        title: "Pod kits",
        subtitle: null,
        cta: { label: "See it", href: `/p/${kit.slug}` },
        image: null,
      },
    ]);
    expect(page.offers).toEqual({
      title: "This week",
      products: [expect.objectContaining({ name: "Halo Home" })],
    });
    // Nothing internal leaves: no IDs, no stock counts.
    const text = JSON.stringify(page);
    for (const internal of [kit.id, halo.id, halo.brandId, "stock"])
      expect(text).not.toContain(internal);

    // The kit is unpublished after the content was: it leaves every section, and the banner
    // keeps its title but loses the button that pointed at it.
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [kit.id]);
    await revalidate();
    const after = await homeData();
    expect(after.featured.map((card) => card.name)).toEqual(["Halo Home"]);
    expect(after.banners).toEqual([{ title: "Pod kits", subtitle: null, cta: null, image: null }]);
    // A hidden brand leaves the brand row and the hero button.
    await pool.query("UPDATE brands SET active=false WHERE id=$1", [halo.brandId]);
    await revalidate();
    const hidden = await homeData();
    expect(hidden.heroSlides[0]?.cta).toBeNull();
    expect(hidden.featured).toEqual([]);
    await pool.query("UPDATE brands SET active=true WHERE id=$1", [halo.brandId]);
  });

  it("reads a hero published before the carousel (v1) as one dark slide", async () => {
    await publish("hero", {
      slides: [
        {
          style: "lilac",
          eyebrow: null,
          title: "Replaced below",
          subtitle: null,
          cta: null,
          secondaryCta: null,
          image: null,
        },
      ],
    });
    // A copy saved and published by the previous release, at schema version 1.
    await pool.query(
      `UPDATE content_sections SET draft = $1::jsonb, schema_version = 1,
          published = $1::jsonb, published_schema_version = 1, version = version + 1,
          published_at = published_at + interval '1 second'
        WHERE key = 'hero'`,
      [
        JSON.stringify({
          eyebrow: "Old",
          title: "One hero",
          subtitle: "From version 1",
          cta: { label: "Shop now", link: { kind: "shop" } },
          image: null,
        }),
      ],
    );
    await revalidate();
    expect((await homeData()).heroSlides).toEqual([
      {
        style: "navy",
        eyebrow: "Old",
        title: "One hero",
        subtitle: "From version 1",
        cta: { label: "Shop now", href: "/shop" },
        secondaryCta: null,
        image: null,
      },
    ]);
  });

  it("works out automatic best sellers from recent, uncancelled orders, in stock only", async () => {
    const top = await visibleProduct("Top Seller");
    const second = await visibleProduct("Second Seller");
    const empty = await visibleProduct("Sold Out Seller");
    await stock(top.variantId, 10);
    await stock(second.variantId, 10);
    // Each seeded order sold one unit of its product within the last 30 days.
    await publish("best_sellers", { mode: "auto", productIds: [] });
    await revalidate();
    const names = (await homeData()).bestSellers.map((card) => card.name);
    expect(names).toContain("Top Seller");
    expect(names).toContain("Second Seller");
    expect(names).not.toContain("Sold Out Seller");
    expect(names.length).toBeLessThanOrEqual(8);
    expect(empty.id).toBeTruthy();
  });
});
