import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { CategoryResponse } from "@ih/contracts";
import { createDatabase, createPool, trashCategory } from "@ih/db";
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
  applicationName: "ih-categories-test",
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
let ownerId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `categories${seq++}@iqoshaven.test`,
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
  fetch(`${base}/v1/admin/categories${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (response: Response) => (await response.json()) as CategoryResponse;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const slug = () => "category-" + randomUUID().slice(0, 8);
async function create(overrides: Record<string, unknown> = {}, cookie = cookies.owner) {
  const response = await call(
    "",
    "POST",
    { name: "Category " + randomUUID().slice(0, 8), slug: slug(), active: true, ...overrides },
    cookie,
  );
  expect(response.status).toBe(201);
  return json(response);
}
const editable = (category: CategoryResponse) => ({
  version: category.version,
  name: category.name,
  slug: category.slug,
  active: category.active,
  sortOrder: category.sortOrder,
});
async function product(categoryId: string, published: boolean) {
  const brand = await db.brand.create({ data: { name: "Brand " + seq++, slug: slug() } });
  return db.product.create({
    data: {
      name: "Synthetic product",
      slug: slug(),
      brandId: brand.id,
      categoryId,
      type: "kit",
      basePriceFils: 2900n,
      taxTreatmentRef: "synthetic-vat",
      taxTreatmentVersion: 1,
      status: published ? "published" : "draft",
    },
  });
}

describe("category administration through the real API and PostgreSQL", () => {
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

  it("lets Staff create and edit categories with atomic audit and catalog.changed", async () => {
    const category = await create({}, cookies.staff);
    expect(category).toMatchObject({ version: 1, imageAssetId: null, publishedProductCount: 0 });
    expect(category).not.toHaveProperty("seo");
    expect(category).not.toHaveProperty("description");
    const response = await call(
      "/" + category.id,
      "PATCH",
      { ...editable(category), sortOrder: 3 },
      cookies.staff,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const audit = await db.auditLog.findMany({
      where: { entityId: category.id },
      orderBy: { id: "asc" },
    });
    expect(audit.map((row) => [row.action, row.entityType])).toEqual([
      ["catalog.category_created", "category"],
      ["catalog.category_updated", "category"],
    ]);
    const events = await db.outboxEvent.findMany({ where: { aggregateId: category.id } });
    expect(events.map((event) => event.payload)).toEqual([
      { entityType: "category", entityId: category.id },
      { entityType: "category", entityId: category.id },
    ]);
  });

  it("keeps SEO Owner-only and rejects invalid or unknown fields", async () => {
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
    const category = await create({ seo });
    expect(category.seo).toEqual(seo);
    expect(
      await json(await call("/" + category.id, "GET", undefined, cookies.staff)),
    ).not.toHaveProperty("seo");
    for (const body of [
      { name: "", slug: slug(), active: true },
      { name: "Bad", slug: "Bad Slug", active: true },
      { name: "Described", slug: slug(), active: true, description: "not a category field" },
      { name: "Image", slug: slug(), active: true, imageKey: "media/x.webp" },
    ])
      expect((await call("", "POST", body)).status).toBe(400);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("/" + randomUUID())).status).toBe(404);
  });

  it("refuses case-insensitive duplicate names and taken slugs with DUPLICATE", async () => {
    const category = await create();
    expect(
      await code(
        await call("", "POST", { name: category.name.toUpperCase(), slug: slug(), active: true }),
      ),
    ).toBe("DUPLICATE");
    expect(
      await code(
        await call("", "POST", { name: "Other " + seq++, slug: category.slug, active: true }),
      ),
    ).toBe("DUPLICATE");
  });

  it("keeps published-product references safe: trash refused with IN_USE, then allowed", async () => {
    const category = await create();
    const published = await product(category.id, true);
    await product(category.id, false);
    const view = await json(await call("/" + category.id));
    expect(view.publishedProductCount).toBe(1);
    expect(
      await code(await call("/" + category.id + "/trash", "POST", { version: 1 }, cookies.staff)),
    ).toBe("IN_USE");
    await db.product.update({ where: { id: published.id }, data: { status: "draft" } });
    const trashed = await call("/" + category.id + "/trash", "POST", { version: 1 }, cookies.staff);
    expect(trashed.status).toBe(200);
    // Publishing under a trashed category is refused by the database.
    await expect(
      db.product.update({ where: { id: published.id }, data: { status: "published" } }),
    ).rejects.toThrow();
    expect(
      await code(await call("/" + category.id, "PATCH", { ...editable(view), version: 2 })),
    ).toBe("TRASHED");
    const restored = await call(
      "/" + category.id + "/restore",
      "POST",
      { version: 2 },
      cookies.staff,
    );
    expect((await json(restored)).trashedAt).toBeNull();
    await db.product.update({ where: { id: published.id }, data: { status: "published" } });
  });

  it("never leaves a published product in a trashed category under concurrency", async () => {
    for (let round = 0; round < 5; round++) {
      const category = await create();
      const draft = await product(category.id, false);
      await Promise.allSettled([
        pool.query("UPDATE products SET status='published' WHERE id=$1", [draft.id]),
        trashCategory(db, { actorId: ownerId, requestId: randomUUID() }, category.id, {
          version: 1,
        }),
      ]);
      const [row] = (
        await pool.query(
          "SELECT p.status, c.deleted_at FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=$1",
          [draft.id],
        )
      ).rows as Array<{ status: string; deleted_at: Date | null }>;
      expect(row!.status === "published" && row!.deleted_at !== null).toBe(false);
    }
  });

  it("keeps slugs stable: renames leave a direct redirect and reclaim works", async () => {
    const category = await create();
    const first = category.slug;
    const second = slug();
    // Changing an existing slug is the Owner's (step 101); Staff are refused.
    expect(
      (
        await call(
          "/" + category.id,
          "PATCH",
          { ...editable(category), slug: second },
          cookies.staff,
        )
      ).status,
    ).toBe(403);
    const renamed = await json(
      await call("/" + category.id, "PATCH", { ...editable(category), slug: second }),
    );
    expect(
      (await db.slugRedirect.findMany({ where: { categoryId: category.id } })).map(
        (r) => r.oldSlug,
      ),
    ).toEqual([first]);
    expect(
      await code(await call("", "POST", { name: "Taker " + seq++, slug: first, active: true })),
    ).toBe("DUPLICATE");
    // Namespaces are separate: a brand may use the same slug.
    await db.brand.create({ data: { name: "Namespace " + seq++, slug: first } });
    await call("/" + category.id, "PATCH", { ...editable(renamed), slug: first });
    expect(
      (await db.slugRedirect.findMany({ where: { categoryId: category.id } })).map(
        (r) => r.oldSlug,
      ),
    ).toEqual([second]);
  });

  it("rejects stale versions, leaves no-ops unversioned and audits only real changes", async () => {
    const category = await create();
    const same = await call("/" + category.id, "PATCH", {
      ...editable(category),
      seo: { title: null, description: null },
    });
    expect((await json(same)).version).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: category.id } })).toBe(1);
    await call("/" + category.id, "PATCH", { ...editable(category), active: false });
    for (const [path, method, body] of [
      ["/" + category.id, "PATCH", { ...editable(category), sortOrder: 4 }],
      ["/" + category.id + "/trash", "POST", { version: 1 }],
      ["/" + category.id + "/restore", "POST", { version: 1 }],
    ] as const)
      expect(await code(await call(path, method, body))).toBe("VERSION_CONFLICT");
    expect((await call("?after=" + encodeURIComponent("9999999." + randomUUID()))).status).toBe(
      400,
    );
  });

  it("pages in sort order and denies a role without the permission", async () => {
    for (const order of [3, 1, 2]) await create({ sortOrder: 90_000 + order });
    const seen: CategoryResponse[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await call("?limit=2" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""))
      ).json()) as { items: CategoryResponse[]; nextCursor: string | null };
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((c) => c.sortOrder).slice(-3)).toEqual([90_001, 90_002, 90_003]);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "catalog.write" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect(
        (await call("", "POST", { name: "Denied", slug: slug(), active: true }, cookies.staff))
          .status,
      ).toBe(403);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
  });
});
