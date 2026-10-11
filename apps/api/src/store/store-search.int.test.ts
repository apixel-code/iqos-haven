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
  storeSearchResponseSchema,
  type StoreSearchResponse,
  type StoreSuggestResponse,
} from "@ih/contracts";
import { adjustStock, createDatabase, createPool } from "@ih/db";
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

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-store-search-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "search-test-1";
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
let staffId = "";
let ip = 0;
const get = (path: string, headers: Record<string, string> = { cookie }) =>
  fetch(`${base}/v1/store/search${path}`, {
    headers: { "x-ih-client-ip": `198.51.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, ...headers },
  });
async function search(query: string) {
  const response = await get(query ? `?${query}` : "");
  expect(response.status, query).toBe(200);
  const body = (await response.json()) as StoreSearchResponse;
  expect(storeSearchResponseSchema.safeParse(body).success, query).toBe(true);
  return body;
}
const names = async (query: string) => (await search(query)).items.map((item) => item.name);
const sorted = async (query: string) => (await names(query)).sort();

type VariantSeed = [Record<string, string>, number, boolean?];
async function product(seed: {
  name: string;
  brandId: string;
  categoryId: string;
  type?: "disposable" | "kit";
  puffCount?: number | null;
  priceFils: number;
  compareAtFils?: number;
  variants: VariantSeed[];
  status?: "draft" | "published";
}) {
  const type = seed.type ?? "disposable";
  const row = await db.product.create({
    data: {
      name: seed.name,
      slug: "p-" + randomUUID().slice(0, 8),
      brandId: seed.brandId,
      categoryId: seed.categoryId,
      type,
      puffCount: type === "disposable" ? (seed.puffCount ?? 7000) : null,
      basePriceFils: BigInt(seed.priceFils),
      compareAtPriceFils: seed.compareAtFils ? BigInt(seed.compareAtFils) : null,
      description: "Synthetic description.",
      specs: { extra: [] },
    },
  });
  const variants = [];
  for (const [index, [attributes, stock, active = true]] of seed.variants.entries()) {
    const variant = await db.variant.create({
      data: {
        productId: row.id,
        sku: "SRCH-" + randomUUID().slice(0, 8).toUpperCase(),
        attributes,
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
  if ((seed.status ?? "published") === "published")
    await db.product.update({
      where: { id: row.id },
      data: { status: "published", taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 },
    });
  return { ...row, variants };
}

describe("gated store search, facets and suggestions (real API and PostgreSQL)", () => {
  let orbe: { id: string; slug: string };
  let kairo: { id: string; slug: string };
  let halo: Awaited<ReturnType<typeof product>>;

  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "search@iqoshaven.test",
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
    orbe = await db.brand.create({ data: { name: "Orbe", slug: "orbe", active: true } });
    kairo = await db.brand.create({ data: { name: "Kairo", slug: "kairo", active: true } });
    const ghost = await db.brand.create({ data: { name: "Ghost", slug: "ghost", active: false } });
    const disposables = await db.category.create({
      data: { name: "Disposables", slug: "disposables", active: true },
    });
    const kits = await db.category.create({ data: { name: "Kits", slug: "kits", active: true } });
    halo = await product({
      name: "Halo 7K",
      brandId: orbe.id,
      categoryId: disposables.id,
      puffCount: 7000,
      priceFils: 4900,
      compareAtFils: 5900,
      variants: [
        [{ flavour: "grape ice", nicotine: "20 mg" }, 5],
        [{ flavour: "mint", nicotine: "50 mg" }, 0],
        [{ flavour: "retired", nicotine: "20 mg" }, 9, false],
      ],
    });
    await product({
      name: "Halo Mini",
      brandId: orbe.id,
      categoryId: disposables.id,
      puffCount: 3000,
      priceFils: 2500,
      variants: [[{ flavour: "peach", nicotine: "20 mg" }, 0]],
    });
    await product({
      name: "Pod Kit X",
      brandId: kairo.id,
      categoryId: kits.id,
      type: "kit",
      priceFils: 9900,
      variants: [[{ colour: "black" }, 3]],
    });
    await product({
      name: "Mint Storm",
      brandId: kairo.id,
      categoryId: disposables.id,
      puffCount: 10000,
      priceFils: 5500,
      variants: [[{ flavour: "mint", nicotine: "50 mg" }, 2]],
    });
    // Never visible to a shopper, whatever is searched.
    await product({
      name: "Secret Grape",
      brandId: orbe.id,
      categoryId: disposables.id,
      priceFils: 100,
      status: "draft",
      variants: [[{ flavour: "grape" }, 5]],
    });
    await product({
      name: "Ghost Mint",
      brandId: ghost.id,
      categoryId: disposables.id,
      priceFils: 100,
      variants: [[{ flavour: "mint" }, 5]],
    });
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

  it("requires a valid age ticket for search and suggestions", async () => {
    for (const path of ["?q=halo", "/suggest?q=halo"])
      for (const headers of [
        {},
        { cookie: `${AGE_COOKIE}=accepted` },
        { "user-agent": "Googlebot/2.1" },
      ] as Array<Record<string, string>>) {
        const response = await get(path, headers);
        const text = await response.text();
        expect(response.status).toBe(403);
        expect(JSON.parse(text).error.code).toBe(AGE_VERIFICATION_REQUIRED);
        expect(text).not.toContain("Halo");
      }
    const ok = await get("?q=halo");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("vary")).toMatch(/cookie/i);
  });

  it("matches names, brands, types, puff counts and active option values by word prefix", async () => {
    expect(await sorted("q=halo")).toEqual(["Halo 7K", "Halo Mini"]);
    expect(await sorted("q=hal")).toEqual(["Halo 7K", "Halo Mini"]);
    expect(await sorted("q=ORBE")).toEqual(["Halo 7K", "Halo Mini"]);
    expect(await sorted("q=kit")).toEqual(["Pod Kit X"]);
    expect(await sorted("q=7k")).toEqual(["Halo 7K"]);
    expect(await sorted("q=10000")).toEqual(["Mint Storm"]);
    expect(await sorted("q=grape")).toEqual(["Halo 7K"]);
    expect(await sorted("q=peach")).toEqual(["Halo Mini"]);
    expect(await sorted("q=black")).toEqual(["Pod Kit X"]);
    // Every word must match: "halo mint" is the Halo with a mint option, not Mint Storm.
    expect(await sorted("q=halo+mint")).toEqual(["Halo 7K"]);
    expect(await sorted("q=kairo+mint")).toEqual(["Mint Storm"]);
    // A name match outranks an option match.
    expect(await names("q=mint")).toEqual(["Mint Storm", "Halo 7K"]);
    expect((await search("q=mint")).sort).toBe("relevance");
  });

  it("falls back to near misses only when the words as typed match nothing", async () => {
    const typo = await search("q=hallo");
    expect(typo.approximate).toBe(true);
    expect(typo.items.map((item) => item.name).sort()).toEqual(["Halo 7K", "Halo Mini"]);
    expect(await sorted("q=kairro")).toEqual(["Mint Storm", "Pod Kit X"]);
    // Every word must still be accounted for, and numbers are never matched roughly.
    expect((await search("q=hallo+zzzz")).total).toBe(0);
    expect((await search("q=hallo+9000")).total).toBe(0);
    expect(await sorted("q=hallo+7000")).toEqual(["Halo 7K"]);
    // A real match is never diluted by look-alikes ("mint" is not "mini").
    const exact = await search("q=mint");
    expect(exact.approximate).toBe(false);
    expect(exact.items.map((item) => item.name)).not.toContain("Halo Mini");
    // Near-miss results page like any other.
    const first = await search("q=hallo&limit=1");
    const second = await search(`q=hallo&limit=1&cursor=${first.nextCursor}`);
    expect(second.approximate).toBe(true);
    expect([first.items[0]!.name, second.items[0]!.name].sort()).toEqual(["Halo 7K", "Halo Mini"]);
    expect(second.nextCursor).toBeNull();
    // The cursor remembers its pass: a product that now matches exactly does not make page two
    // switch to a different result set.
    const category = await db.category.findFirstOrThrow({ where: { slug: "disposables" } });
    const late = await product({
      name: "Hallo Exact",
      brandId: orbe.id,
      categoryId: category.id,
      priceFils: 100,
      variants: [[{ flavour: "plain" }, 1]],
    });
    const resumed = await search(`q=hallo&limit=1&cursor=${first.nextCursor}`);
    expect(resumed.approximate).toBe(true);
    expect((await search("q=hallo")).approximate).toBe(false);
    await db.product.update({ where: { id: late.id }, data: { status: "draft" } });
  });

  it("never finds drafts, hidden brands or inactive options", async () => {
    for (const q of ["secret", "ghost", "retired", "secret+grape"])
      expect((await search(`q=${q}`)).total, q).toBe(0);
    expect(await sorted("q=grape")).not.toContain("Secret Grape");
    expect(await sorted("q=mint")).not.toContain("Ghost Mint");
  });

  it("answers an empty result with zero counts, not an error", async () => {
    const result = await search("q=zzzzqqq");
    expect(result).toMatchObject({
      query: "zzzzqqq",
      total: 0,
      items: [],
      nextCursor: null,
      facets: {
        types: [],
        brands: [],
        puffCounts: [],
        nicotine: [],
        price: null,
        inStock: 0,
        onSale: 0,
      },
    });
  });

  it("treats hostile and odd search text as plain text", async () => {
    const productsBefore = await db.product.count();
    for (const q of [
      "'; DROP TABLE products;--",
      "a:* | b & !c",
      "%",
      "_",
      "\\",
      "<script>alert(1)</script>",
      "''''",
      "()",
      "halo\u0000",
      "عنب",
      "🙂",
      " ",
    ]) {
      const response = await get(`?q=${encodeURIComponent(q)}`);
      expect(response.status, q).toBe(200);
      const body = (await response.json()) as StoreSearchResponse;
      // The echoed term is letters, digits and spaces only.
      expect(body.query, q).toMatch(/^[\p{L}\p{N} ]*$/u);
    }
    expect((await search(`q=${encodeURIComponent("halo'; DROP TABLE products;--")}`)).query).toBe(
      "halo drop table products",
    );
    expect(await db.product.count()).toBe(productsBefore);
    // Punctuation only is the same as no term: everything, newest first.
    expect(await search("q=%25")).toMatchObject({ query: "", sort: "newest", total: 4 });
  });

  it("counts each facet with the other filters applied and its own ignored", async () => {
    const all = await search("");
    expect(all).toMatchObject({ query: "", sort: "newest", total: 4 });
    expect(all.facets).toEqual({
      types: [
        { type: "disposable", count: 3 },
        { type: "kit", count: 1 },
      ],
      brands: [
        { slug: "kairo", name: "Kairo", count: 2 },
        { slug: "orbe", name: "Orbe", count: 2 },
      ],
      puffCounts: [
        { puffCount: 3000, count: 1 },
        { puffCount: 7000, count: 1 },
        { puffCount: 10000, count: 1 },
      ],
      // Halo 7K offers both strengths, so it counts under each.
      nicotine: [
        { value: "20 mg", count: 2 },
        { value: "50 mg", count: 2 },
      ],
      price: { minFils: 2500, maxFils: 9900 },
      inStock: 3,
      onSale: 1,
    });

    const disposables = await search("type=disposable");
    expect(disposables.total).toBe(3);
    // Own facet ignored: the other type is still offered.
    expect(disposables.facets.types).toEqual(all.facets.types);
    expect(disposables.facets.brands).toEqual([
      { slug: "kairo", name: "Kairo", count: 1 },
      { slug: "orbe", name: "Orbe", count: 2 },
    ]);
    expect(disposables.facets.price).toEqual({ minFils: 2500, maxFils: 5500 });

    const orbeOnly = await search("brand=orbe");
    expect(orbeOnly.total).toBe(2);
    expect(orbeOnly.facets.brands).toEqual(all.facets.brands);
    expect(orbeOnly.facets.types).toEqual([{ type: "disposable", count: 2 }]);
    expect((await search("brand=orbe&brand=kairo")).total).toBe(4);

    expect(await sorted("minPriceFils=3000&maxPriceFils=6000")).toEqual(["Halo 7K", "Mint Storm"]);
    expect(await sorted("minPuffs=5000")).toEqual(["Halo 7K", "Mint Storm"]);
    expect(await sorted("maxPuffs=5000")).toEqual(["Halo Mini"]);
    expect(await sorted(`nicotine=${encodeURIComponent("50 MG")}`)).toEqual([
      "Halo 7K",
      "Mint Storm",
    ]);
    expect(await sorted("inStock=true")).toEqual(["Halo 7K", "Mint Storm", "Pod Kit X"]);
    expect(await sorted("onSale=true")).toEqual(["Halo 7K"]);
    expect(await sorted("inStock=false")).toHaveLength(4);

    const combined = await search(
      `type=disposable&inStock=true&nicotine=${encodeURIComponent("20 mg")}`,
    );
    expect(combined.items.map((item) => item.name)).toEqual(["Halo 7K"]);
    expect(combined.total).toBe(1);
    // With the stock filter ignored, the sold-out 20 mg product is counted as available to add.
    expect(combined.facets.inStock).toBe(1);
    expect(combined.facets.nicotine).toEqual([
      { value: "20 mg", count: 1 },
      { value: "50 mg", count: 2 },
    ]);

    // Facets follow the search term as well.
    const mint = await search("q=mint");
    expect(mint.total).toBe(2);
    expect(mint.facets.brands).toEqual(all.facets.brands.map((brand) => ({ ...brand, count: 1 })));
  });

  it("pages every sort with a stable cursor, and total equals the walked count", async () => {
    async function walk(query: string) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let total = -1;
      for (let page = 0; page < 20; page++) {
        const result: StoreSearchResponse = await search(
          `${query}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        total = result.total;
        seen.push(...result.items.map((item) => item.name));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(seen.length).toBe(total);
      expect(new Set(seen).size).toBe(seen.length);
      return seen;
    }
    expect(await walk("sort=price_asc")).toEqual([
      "Halo Mini",
      "Halo 7K",
      "Mint Storm",
      "Pod Kit X",
    ]);
    expect(await walk("sort=price_desc")).toEqual([
      "Pod Kit X",
      "Mint Storm",
      "Halo 7K",
      "Halo Mini",
    ]);
    expect(await walk("sort=name")).toEqual(["Halo 7K", "Halo Mini", "Mint Storm", "Pod Kit X"]);
    expect(await walk("sort=newest")).toEqual(["Mint Storm", "Pod Kit X", "Halo Mini", "Halo 7K"]);
    expect(await walk("q=mint")).toEqual(["Mint Storm", "Halo 7K"]);
    expect(await walk("q=halo&sort=price_desc")).toEqual(["Halo 7K", "Halo Mini"]);
    expect(await walk("type=disposable&sort=name")).toEqual(["Halo 7K", "Halo Mini", "Mint Storm"]);
  });

  it("bounds and validates every input", async () => {
    const relevance = (await search("q=mint&limit=1")).nextCursor!;
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const query of [
      "q=" + "a".repeat(201),
      "limit=0",
      "limit=49",
      "sort=rank",
      "sort=price_asc;DROP",
      "type=pod",
      "brand=Not%20Slug",
      "brand=" + Array.from({ length: 11 }, (_, index) => "b" + index).join("&brand="),
      "minPriceFils=-1",
      "maxPriceFils=1000000001",
      "minPriceFils=500&maxPriceFils=100",
      "minPuffs=0",
      "minPuffs=9000&maxPuffs=100",
      "minPriceFils=1.5",
      "nicotine=" + "x".repeat(41),
      "nicotine=" + Array.from({ length: 7 }, (_, index) => "n" + index).join("&nicotine="),
      "inStock=yes",
      "onSale=1",
      "category=disposables",
      "unknown=1",
      "cursor=not*base64",
      // A relevance cursor is refused for another sort, and without a term.
      `q=mint&sort=name&cursor=${relevance}`,
      `cursor=${relevance}`,
      "q=mint&cursor=" + forged(["relevance", 999_999_999_999, randomUUID()]),
      "q=mint&cursor=" + forged(["relevance", "high", randomUUID()]),
      "q=mint&cursor=" + forged(["relevance", 5, "not-a-uuid"]),
    ]) {
      const response = await get(`?${query}`);
      expect(response.status, query).toBe(400);
    }
    for (const query of ["", "q=a&q=b", "q=" + "a".repeat(201), "q=a&limit=5"])
      expect((await get(`/suggest?${query}`)).status, query).toBe(400);
  });

  it("returns cards only: no SKU, stock count, rank or search text", async () => {
    const text = await (await get("?q=halo")).text();
    for (const secret of [
      ...halo.variants.map((v) => v.sku),
      "stock",
      "rank",
      "search_text",
      "sku",
      'nicotine":["',
      staffId,
    ])
      expect(text, secret).not.toContain(secret);
  });

  it("keeps the projection current when the catalogue changes", async () => {
    const category = await db.category.findFirstOrThrow({ where: { slug: "disposables" } });
    const brand = await db.brand.create({ data: { name: "Nimbus", slug: "nimbus", active: true } });
    const fresh = await product({
      name: "Aurora Bar",
      brandId: brand.id,
      categoryId: category.id,
      priceFils: 3900,
      variants: [[{ flavour: "lychee" }, 1]],
    });
    expect(await sorted("q=aurora")).toEqual(["Aurora Bar"]);
    expect(await sorted("q=nimbus")).toEqual(["Aurora Bar"]);
    expect(await sorted("q=lychee")).toEqual(["Aurora Bar"]);
    // Rename the product and the brand.
    await db.product.update({ where: { id: fresh.id }, data: { name: "Borealis Bar" } });
    await db.brand.update({ where: { id: brand.id }, data: { name: "Stratus" } });
    expect((await search("q=aurora")).total).toBe(0);
    expect((await search("q=nimbus")).total).toBe(0);
    expect(await sorted("q=borealis")).toEqual(["Borealis Bar"]);
    expect(await sorted("q=stratus")).toEqual(["Borealis Bar"]);
    // Add an option, then deactivate the first one.
    await db.variant.create({
      data: {
        productId: fresh.id,
        sku: "SRCH-" + randomUUID().slice(0, 8).toUpperCase(),
        attributes: { flavour: "mango" },
        active: true,
      },
    });
    expect(await sorted("q=mango")).toEqual(["Borealis Bar"]);
    await db.variant.update({ where: { id: fresh.variants[0]!.id }, data: { active: false } });
    expect((await search("q=lychee")).total).toBe(0);
    expect(await sorted("q=mango")).toEqual(["Borealis Bar"]);
    // Unpublishing removes it from search at once (search is not cached).
    await db.product.update({ where: { id: fresh.id }, data: { status: "draft" } });
    expect((await search("q=borealis")).total).toBe(0);
  });

  it("suggests visible products and brands for two or more characters", async () => {
    const suggest = async (q: string) => {
      const response = await get(`/suggest?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      return (await response.json()) as StoreSuggestResponse;
    };
    const ha = await suggest("ha");
    expect(ha.query).toBe("ha");
    expect(ha.products.map((item) => item.name).sort()).toEqual(["Halo 7K", "Halo Mini"]);
    expect(ha.products[0]).toEqual({
      slug: expect.any(String),
      name: expect.any(String),
      brandName: "Orbe",
    });
    expect((await suggest("ka")).brands).toEqual([{ slug: "kairo", name: "Kairo" }]);
    expect(await suggest("h")).toEqual({ query: "h", products: [], brands: [] });
    expect(await suggest("%")).toEqual({ query: "", products: [], brands: [] });
    const hidden = await suggest("gh");
    expect(hidden.brands).toEqual([]);
    expect(hidden.products.map((item) => item.name)).not.toContain("Ghost Mint");
    expect((await suggest("secret")).products).toEqual([]);
  });

  it("limits searches per client address", async () => {
    const headers = { cookie, "x-ih-client-ip": "203.0.113.201" };
    const statuses = (
      await Promise.all(Array.from({ length: 65 }, () => get("?q=halo", headers)))
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});
