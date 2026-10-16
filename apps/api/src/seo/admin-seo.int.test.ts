import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { publicSeoPolicySchema, seoIssuesResponseSchema, seoOverviewSchema } from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
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
  applicationName: "ih-admin-seo-test",
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
let staff = "";
let host = 10;
const call = (path: string, cookie: string | null, body?: unknown) =>
  fetch(`${base}/v1${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      ...(cookie ? { cookie } : {}),
      origin: ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const publicPolicy = async () =>
  publicSeoPolicySchema.parse(await (await call("/public/seo", null)).json());

describe("SEO policy, overview and issue report through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      await db.staffUser.create({
        data: {
          email,
          name: "Seo " + key,
          roleId: role.id,
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
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    owner = await login("owner", "seo-owner@iqoshaven.test");
    staff = await login("staff", "seo-staff@iqoshaven.test");
    // Pages to check: a fine product, one with a long title, two sharing a title, a draft.
    const brand = await db.brand.create({
      data: {
        name: "Orbe",
        slug: "orbe",
        active: true,
        seo: { title: "Orbe vapes", description: "Orbe in the UAE" },
      },
    });
    const category = await db.category.create({
      data: { name: "Kits", slug: "kits", active: true },
    });
    const product = (name: string, slug: string, seo: object, status = "published") =>
      db.product.create({
        data: {
          name,
          slug,
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 5000n,
          status,
          seo,
        },
      });
    await product("Halo", "halo", { title: "Halo kit", description: "A kit" });
    await product("Long", "long", { title: "x".repeat(80), description: "ok" });
    await product("Twin A", "twin-a", { title: "Orbe vapes", description: "ok" });
    await product("Hidden", "hidden", {}, "draft");
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("is closed until the Owner chooses, and the public answer holds the policy only", async () => {
    const response = await call("/public/seo", null);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.json()).toEqual({ indexing: "closed" });
    const overview = seoOverviewSchema.parse(await (await call("/admin/seo", owner)).json());
    expect(overview).toMatchObject({ policy: { indexing: "closed" }, version: 0, updatedAt: null });
    const state = Object.fromEntries(overview.features.map((f) => [f.key, f.state]));
    expect(state).toEqual({
      generic_previews: "active",
      base_canonical: "active",
      slug_redirects: "active",
      public_sitemap: "inactive",
      product_indexing: "inactive",
      product_previews: "inactive",
      product_json_ld: "inactive",
    });
  });

  it("lets only the Owner set it, at the expected version, audited once", async () => {
    expect((await call("/admin/seo", staff)).status).toBe(403);
    expect(
      (await call("/admin/seo/policy", staff, { expectedVersion: 0, indexing: "public_pages" }))
        .status,
    ).toBe(403);
    expect(
      (await call("/admin/seo/policy", null, { expectedVersion: 0, indexing: "closed" })).status,
    ).toBe(401);
    for (const body of [
      { expectedVersion: 0, indexing: "products" },
      { expectedVersion: 0, indexing: "public_pages", extra: true },
      { indexing: "public_pages" },
    ])
      expect((await call("/admin/seo/policy", owner, body)).status).toBe(400);
    const opened = await call("/admin/seo/policy", owner, {
      expectedVersion: 0,
      indexing: "public_pages",
    });
    expect(opened.status).toBe(200);
    const overview = seoOverviewSchema.parse(await opened.json());
    expect(overview).toMatchObject({ policy: { indexing: "public_pages" }, version: 1 });
    expect(overview.features.find((f) => f.key === "public_sitemap")!.state).toBe("active");
    // Product indexing never turns on from here.
    expect(overview.features.find((f) => f.key === "product_indexing")!.state).toBe("inactive");
    expect(await publicPolicy()).toEqual({ indexing: "public_pages" });
    // A stale version is refused; the same choice again changes nothing.
    const stale = await call("/admin/seo/policy", owner, {
      expectedVersion: 0,
      indexing: "closed",
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "VERSION_CONFLICT",
    );
    const same = seoOverviewSchema.parse(
      await (
        await call("/admin/seo/policy", owner, { expectedVersion: 1, indexing: "public_pages" })
      ).json(),
    );
    expect(same.version).toBe(1);
    expect(await db.auditLog.count({ where: { action: "seo.policy_updated" } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { eventType: "seo.policy_updated" } })).toBe(1);
    // Back to closed.
    await call("/admin/seo/policy", owner, { expectedVersion: 1, indexing: "closed" });
    expect(await publicPolicy()).toEqual({ indexing: "closed" });
    // The general Settings screen does not list or write it.
    const settings = (await (await call("/admin/settings", owner)).json()) as {
      items: Array<{ key: string }>;
    };
    expect(settings.items.map((item) => item.key)).not.toContain("seo");
  });

  it("reports missing, long and duplicate titles of what shoppers can reach", async () => {
    expect((await call("/admin/seo/issues", staff)).status).toBe(403);
    const report = seoIssuesResponseSchema.parse(
      await (await call("/admin/seo/issues", owner)).json(),
    );
    expect(report.checked).toEqual({ products: 3, brands: 1, categories: 1 });
    expect(report.limits).toEqual({ title: 60, description: 160 });
    expect(report.counts).toMatchObject({
      title_too_long: 1,
      duplicate_title: 2,
      missing_title: 1,
      missing_description: 1,
    });
    const kinds = (name: string) =>
      report.items
        .filter((item) => item.name === name)
        .map((item) => item.kind)
        .sort();
    expect(kinds("Long")).toEqual(["title_too_long"]);
    expect(kinds("Twin A")).toEqual(["duplicate_title"]);
    expect(kinds("Orbe")).toEqual(["duplicate_title"]);
    expect(kinds("Kits")).toEqual(["missing_description", "missing_title"]);
    expect(kinds("Halo")).toEqual([]);
    // A draft is not checked.
    expect(report.items.some((item) => item.name === "Hidden")).toBe(false);
  });
});
