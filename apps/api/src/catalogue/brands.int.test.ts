import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { BrandResponse } from "@ih/contracts";
import {
  createDatabase,
  createPool,
  updateBrand,
  trashBrand,
  CatalogueConflictError,
  CatalogueForbiddenError,
} from "@ih/db";
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
  applicationName: "ih-brands-test",
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
let base: string;
let seq = 0;
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };
let ownerId = "";

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `brands${seq++}@iqoshaven.test`,
      name: "Test Person",
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
const call = (path: string, method = "GET", body?: unknown, cookie = cookies.owner) =>
  fetch(`${base}/v1/admin/brands${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (response: Response) => (await response.json()) as BrandResponse;
const slug = () => "brand-" + randomUUID().slice(0, 8);
async function create(overrides: Record<string, unknown> = {}, cookie = cookies.owner) {
  const response = await call(
    "",
    "POST",
    { name: "Brand " + randomUUID().slice(0, 8), slug: slug(), active: true, ...overrides },
    cookie,
  );
  expect(response.status).toBe(201);
  return json(response);
}
const editable = (brand: BrandResponse) => ({
  version: brand.version,
  name: brand.name,
  slug: brand.slug,
  description: brand.description,
  active: brand.active,
  sortOrder: brand.sortOrder,
});
async function publishedProduct(brandId: string) {
  const category = await db.category.create({ data: { name: "Category " + seq++, slug: slug() } });
  return db.product.create({
    data: {
      name: "Synthetic product",
      slug: slug(),
      brandId,
      categoryId: category.id,
      type: "kit",
      basePriceFils: 2900n,
      taxTreatmentRef: "synthetic-vat",
      taxTreatmentVersion: 1,
      status: "published",
    },
  });
}

describe("brand administration through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
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

  it("lets Staff create and edit brands, writing audit and an IDs-only event atomically", async () => {
    const brand = await create({ description: "Synthetic description" }, cookies.staff);
    expect(brand).toMatchObject({
      version: 1,
      active: true,
      trashedAt: null,
      publishedProductCount: 0,
    });
    expect(brand).not.toHaveProperty("seo");
    const response = await call(
      "/" + brand.id,
      "PATCH",
      { ...editable(brand), name: brand.name + " Plus", sortOrder: 5 },
      cookies.staff,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toMatchObject({ version: 2, sortOrder: 5 });
    const audit = await db.auditLog.findMany({
      where: { entityId: brand.id },
      orderBy: { id: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "catalog.brand_created",
      "catalog.brand_updated",
    ]);
    const events = await db.outboxEvent.findMany({ where: { aggregateId: brand.id } });
    expect(events.map((event) => event.payload)).toEqual([
      { entityType: "brand", entityId: brand.id },
      { entityType: "brand", entityId: brand.id },
    ]);
  });

  it("keeps SEO fields Owner-only to read and write", async () => {
    const seo = { title: "Synthetic title", description: "Synthetic meta" };
    expect(
      (
        await call(
          "",
          "POST",
          { name: "Seo " + seq++, slug: slug(), active: true, seo },
          cookies.staff,
        )
      ).status,
    ).toBe(403);
    const brand = await create({ seo });
    expect(brand.seo).toEqual(seo);
    const staffView = await json(await call("/" + brand.id, "GET", undefined, cookies.staff));
    expect(staffView).not.toHaveProperty("seo");
    const list = await (await call("?limit=100", "GET", undefined, cookies.staff)).text();
    expect(list).not.toContain("Synthetic title");
    // Staff may edit other fields; omitting seo leaves it unchanged.
    const edited = await call(
      "/" + brand.id,
      "PATCH",
      { ...editable(brand), active: false },
      cookies.staff,
    );
    expect(edited.status).toBe(200);
    expect((await json(await call("/" + brand.id))).seo).toEqual(seo);
    const withSeo = await call(
      "/" + brand.id,
      "PATCH",
      { ...editable(brand), version: 2, seo: { title: null, description: null } },
      cookies.staff,
    );
    expect(withSeo.status).toBe(403);
  });

  it("rejects invalid input, unknown fields and anonymous callers", async () => {
    for (const body of [
      { name: "", slug: slug(), active: true },
      { name: "Bad slug", slug: "Bad Slug", active: true },
      { name: "Too long", slug: "a".repeat(151), active: true },
      { name: "Order", slug: slug(), active: true, sortOrder: -1 },
      { name: "Extra", slug: slug(), active: true, logoKey: "media/x.webp" },
      { name: "Money", slug: slug(), active: true, id: randomUUID() },
    ]) {
      const response = await call("", "POST", body);
      expect(response.status).toBe(400);
    }
    expect((await call("/not-a-uuid")).status).toBe(400);
    expect((await call("?limit=101")).status).toBe(400);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("/" + randomUUID())).status).toBe(404);
  });

  it("refuses duplicate names (case-insensitive) and slugs, including trashed brands", async () => {
    const brand = await create({ name: "Unique Name " + seq });
    expect(
      (await call("", "POST", { name: brand.name.toUpperCase(), slug: slug(), active: true }))
        .status,
    ).toBe(409);
    expect(
      (await call("", "POST", { name: "Other " + seq++, slug: brand.slug, active: true })).status,
    ).toBe(409);
    await call("/" + brand.id + "/trash", "POST", { version: brand.version });
    expect((await call("", "POST", { name: brand.name, slug: slug(), active: true })).status).toBe(
      409,
    );
  });

  it("rejects stale versions and edits to trashed brands", async () => {
    const brand = await create();
    expect((await call("/" + brand.id, "PATCH", editable(brand))).status).toBe(200); // no-op
    expect((await json(await call("/" + brand.id))).version).toBe(1);
    await call("/" + brand.id, "PATCH", { ...editable(brand), active: false });
    expect((await call("/" + brand.id, "PATCH", { ...editable(brand), sortOrder: 9 })).status).toBe(
      409,
    );
    const trashed = await json(await call("/" + brand.id + "/trash", "POST", { version: 2 }));
    expect(trashed.trashedAt).not.toBeNull();
    expect(
      (await call("/" + brand.id, "PATCH", { ...editable(trashed), sortOrder: 9 })).status,
    ).toBe(409);
    expect(
      (await call("/" + brand.id + "/trash", "POST", { version: trashed.version })).status,
    ).toBe(409);
  });

  it("concurrent edits from the same version have exactly one winner", async () => {
    const brand = await create();
    const context = () => ({ actorId: ownerId, requestId: randomUUID() });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((order) =>
        updateBrand(db, context(), brand.id, { ...editable(brand), sortOrder: order }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(CatalogueConflictError);
    expect((await json(await call("/" + brand.id))).version).toBe(2);
  });

  it("refuses to trash a brand used by live published products, and restores trashed ones", async () => {
    const brand = await create();
    const product = await publishedProduct(brand.id);
    const view = await json(await call("/" + brand.id));
    expect(view.publishedProductCount).toBe(1);
    expect(
      (await call("/" + brand.id + "/trash", "POST", { version: view.version }, cookies.staff))
        .status,
    ).toBe(409);
    expect((await db.brand.findUniqueOrThrow({ where: { id: brand.id } })).deletedAt).toBeNull();
    // A draft product does not hold the brand.
    await db.product.update({ where: { id: product.id }, data: { status: "draft" } });
    const trashed = await call(
      "/" + brand.id + "/trash",
      "POST",
      { version: view.version },
      cookies.staff,
    );
    expect(trashed.status).toBe(200);
    const trash = (await (await call("?status=trashed&limit=100")).json()) as {
      items: BrandResponse[];
    };
    expect(trash.items.map((item) => item.id)).toContain(brand.id);
    const live = (await (await call("?limit=100")).json()) as { items: BrandResponse[] };
    expect(live.items.map((item) => item.id)).not.toContain(brand.id);
    const restored = await call(
      "/" + brand.id + "/restore",
      "POST",
      { version: view.version + 1 },
      cookies.staff,
    );
    expect(restored.status).toBe(200);
    expect((await json(restored)).trashedAt).toBeNull();
    // Product rows are never touched by brand trash/restore.
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).brandId).toBe(
      brand.id,
    );
  });

  it("renames slugs with a direct redirect and lets a brand reclaim its old slug", async () => {
    const brand = await create();
    const first = brand.slug;
    const second = slug();
    const renamed = await json(
      await call("/" + brand.id, "PATCH", { ...editable(brand), slug: second }),
    );
    expect(renamed.slug).toBe(second);
    const redirects = await db.slugRedirect.findMany({ where: { brandId: brand.id } });
    expect(redirects.map((row) => row.oldSlug)).toEqual([first]);
    // Another brand cannot take the reserved alias.
    expect(
      (await call("", "POST", { name: "Taker " + seq++, slug: first, active: true })).status,
    ).toBe(409);
    const back = await call("/" + brand.id, "PATCH", { ...editable(renamed), slug: first });
    expect(back.status).toBe(200);
    const after = await db.slugRedirect.findMany({ where: { brandId: brand.id } });
    expect(after.map((row) => row.oldSlug)).toEqual([second]);
  });

  it("orders by sort order with a stable keyset cursor", async () => {
    for (const order of [30, 10, 20]) await create({ sortOrder: 50_000 + order });
    const seen: BrandResponse[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await call("?limit=2" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""))
      ).json()) as { items: BrandResponse[]; nextCursor: string | null };
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const orders = seen.map((brand) => brand.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(seen.map((brand) => brand.id)).size).toBe(seen.length);
    expect(orders.slice(-3)).toEqual([50_010, 50_020, 50_030]);
  });

  it("names the conflict reason in the 409 envelope", async () => {
    const brand = await create();
    const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;
    expect(
      await code(await call("", "POST", { name: brand.name, slug: slug(), active: true })),
    ).toBe("DUPLICATE");
    await call("/" + brand.id, "PATCH", { ...editable(brand), sortOrder: 7 });
    expect(
      await code(await call("/" + brand.id, "PATCH", { ...editable(brand), sortOrder: 8 })),
    ).toBe("VERSION_CONFLICT");
    await publishedProduct(brand.id);
    expect(await code(await call("/" + brand.id + "/trash", "POST", { version: 2 }))).toBe(
      "IN_USE",
    );
  });

  it("does not version an Owner save that leaves empty SEO empty", async () => {
    const brand = await create();
    const response = await call("/" + brand.id, "PATCH", {
      ...editable(brand),
      seo: { title: null, description: null },
    });
    expect((await json(response)).version).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: brand.id } })).toBe(1);
  });

  it("rejects malformed cursors as invalid input", async () => {
    for (const after of ["1.------------------------------------", "x." + randomUUID(), "1"])
      expect((await call("?after=" + encodeURIComponent(after))).status).toBe(400);
  });

  it("rechecks the actor inside the transaction", async () => {
    const brand = await create();
    const staff = await user("staff");
    const context = { actorId: staff.id, requestId: randomUUID() };
    await db.staffUser.update({ where: { id: staff.id }, data: { active: false } });
    await expect(trashBrand(db, context, brand.id, { version: 1 })).rejects.toBeInstanceOf(
      CatalogueForbiddenError,
    );
    expect((await db.brand.findUniqueOrThrow({ where: { id: brand.id } })).deletedAt).toBeNull();
  });

  it("never leaves a published product on a trashed brand, even under concurrency", async () => {
    // Publishing onto an already trashed brand is refused by the database.
    const trashedBrand = await create();
    await call("/" + trashedBrand.id + "/trash", "POST", { version: 1 });
    await expect(publishedProduct(trashedBrand.id)).rejects.toThrow();
    // Race: one transaction publishes while another trashes the same brand.
    for (let round = 0; round < 5; round++) {
      const brand = await create();
      const category = await db.category.create({ data: { name: "Race " + seq++, slug: slug() } });
      const draft = await db.product.create({
        data: {
          name: "Race product",
          slug: slug(),
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 2900n,
          taxTreatmentRef: "synthetic-vat",
          taxTreatmentVersion: 1,
        },
      });
      await Promise.allSettled([
        pool.query("UPDATE products SET status='published' WHERE id=$1", [draft.id]),
        trashBrand(db, { actorId: ownerId, requestId: randomUUID() }, brand.id, { version: 1 }),
      ]);
      const [row] = (
        await pool.query(
          "SELECT p.status, b.deleted_at FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.id=$1",
          [draft.id],
        )
      ).rows as Array<{ status: string; deleted_at: Date | null }>;
      expect(row!.status === "published" && row!.deleted_at !== null).toBe(false);
    }
  });

  it("denies roles without the action's permission", async () => {
    const brand = await create();
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "catalog.trash" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect(
        (await call("/" + brand.id + "/trash", "POST", { version: 1 }, cookies.staff)).status,
      ).toBe(403);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
  });
});
