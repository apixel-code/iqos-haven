import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { ProductResponse, ProductSummary } from "@ih/contracts";
import { createDatabase, createPool, updateProduct, CatalogueConflictError } from "@ih/db";
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
  applicationName: "ih-products-test",
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
let brandId = "";
let categoryId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `products${seq++}@iqoshaven.test`,
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
  fetch(`${base}/v1/admin/products${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (response: Response) => (await response.json()) as ProductResponse;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const slug = () => "product-" + randomUUID().slice(0, 8);
const parent = (kind: "brand" | "category") => {
  const data = { data: { name: `${kind} ${seq++}`, slug: slug() } };
  return kind === "brand" ? db.brand.create(data) : db.category.create(data);
};
const disposable = (overrides: Record<string, unknown> = {}) => ({
  type: "disposable",
  name: "Synthetic Disposable " + seq++,
  slug: slug(),
  brandId,
  categoryId,
  puffCount: 6000,
  basePriceFils: 4900,
  compareAtPriceFils: 5900,
  description: "Synthetic description",
  isNew: true,
  specs: { liquidMl: "12.5", batteryMah: 650, rechargeable: true, charging: "USB-C", extra: [] },
  ...overrides,
});
async function create(overrides: Record<string, unknown> = {}, cookie = cookies.owner) {
  const response = await call("", "POST", disposable(overrides), cookie);
  expect(response.status).toBe(201);
  return json(response);
}
const editable = (product: ProductResponse) => ({
  version: product.version,
  type: product.type,
  name: product.name,
  slug: product.slug,
  brandId: product.brand.id,
  categoryId: product.category.id,
  puffCount: product.puffCount,
  basePriceFils: product.basePriceFils,
  compareAtPriceFils: product.compareAtPriceFils,
  description: product.description,
  isNew: product.isNew,
  specs: product.specs,
});

describe("product administration through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
    brandId = (await parent("brand")).id;
    categoryId = (await parent("category")).id;
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

  it("lets Staff create a draft disposable with typed specs and integer fils", async () => {
    const product = await create({}, cookies.staff);
    expect(product).toMatchObject({
      status: "draft",
      version: 1,
      type: "disposable",
      puffCount: 6000,
      basePriceFils: 4900,
      compareAtPriceFils: 5900,
      taxTreatment: null,
      brand: { id: brandId },
      category: { id: categoryId },
      specs: { liquidMl: "12.5", batteryMah: 650 },
    });
    expect(product).not.toHaveProperty("seo");
    const audit = await db.auditLog.findMany({ where: { entityId: product.id } });
    expect(audit.map((row) => row.action)).toEqual(["catalog.product_created"]);
    const events = await db.outboxEvent.findMany({ where: { aggregateId: product.id } });
    expect(events.map((event) => event.payload)).toEqual([
      { entityType: "product", entityId: product.id },
    ]);
  });

  it("creates kits with kit specs and no puff count", async () => {
    const kit = await create({
      type: "kit",
      puffCount: null,
      specs: { batteryMah: 1000, maxOutputW: 25, podCapacityMl: "2", coilOhm: "0.8", extra: [] },
    });
    expect(kit.specs).toMatchObject({ coilOhm: "0.8", maxOutputW: 25 });
  });

  it("rejects invalid products before touching the database", async () => {
    const cases = [
      { basePriceFils: 49.5 },
      { basePriceFils: -1 },
      { basePriceFils: 1_000_000_001 },
      { compareAtPriceFils: 4900 },
      { puffCount: 0 },
      { type: "kit", puffCount: 6000, specs: { extra: [] } },
      { type: "kit", puffCount: null, specs: { liquidMl: "2", extra: [] } },
      { type: "pod", puffCount: null },
      { specs: { liquidMl: "12.55", extra: [] } },
      { specs: { liquidMl: 12.5, extra: [] } },
      { specs: { extra: Array.from({ length: 13 }, () => ({ label: "a", value: "b" })) } },
      { slug: "Not A Slug" },
      { status: "published" },
      { taxTreatment: { ref: "self-approved", version: 1 } },
      { brandId: "not-a-uuid" },
      { unknown: true },
      { name: "Nul\u0000name" },
      { description: "Nul\u0000description" },
      { specs: { charging: "USB\u0000C", extra: [] } },
    ];
    const before = await db.product.count();
    for (const overrides of cases) {
      const response = await call("", "POST", disposable(overrides));
      expect(response.status, JSON.stringify(overrides)).toBe(400);
    }
    expect(await db.product.count()).toBe(before);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("/" + randomUUID())).status).toBe(404);
  });

  it("requires live, existing brand and category", async () => {
    const trashed = await parent("brand");
    await db.brand.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
    for (const overrides of [{ brandId: trashed.id }, { categoryId: randomUUID() }])
      expect(await code(await call("", "POST", disposable(overrides)))).toBe("PARENT_UNAVAILABLE");
  });

  it("keeps SEO Owner-only and slugs unique with redirects on rename", async () => {
    const seo = { title: "Synthetic title", description: "Synthetic meta" };
    expect((await call("", "POST", disposable({ seo }), cookies.staff)).status).toBe(403);
    const product = await create({ seo });
    expect(product.seo).toEqual(seo);
    expect(
      await json(await call("/" + product.id, "GET", undefined, cookies.staff)),
    ).not.toHaveProperty("seo");
    expect(await code(await call("", "POST", disposable({ slug: product.slug })))).toBe(
      "DUPLICATE",
    );
    const renamed = await json(
      await call("/" + product.id, "PATCH", { ...editable(product), slug: slug() }, cookies.staff),
    );
    expect(renamed.seo).toBeUndefined(); // Staff view
    const redirects = await db.slugRedirect.findMany({ where: { productId: product.id } });
    expect(redirects.map((row) => row.oldSlug)).toEqual([product.slug]);
    expect((await json(await call("/" + product.id))).seo).toEqual(seo);
  });

  it("conflicts on stale edits, keeps no-ops unversioned and audits change flags", async () => {
    const product = await create();
    expect((await json(await call("/" + product.id, "PATCH", editable(product)))).version).toBe(1);
    const edited = await json(
      await call("/" + product.id, "PATCH", {
        ...editable(product),
        basePriceFils: 5200,
        compareAtPriceFils: null,
        specs: { ...product.specs, batteryMah: 700 },
      }),
    );
    expect(edited).toMatchObject({ version: 2, basePriceFils: 5200, compareAtPriceFils: null });
    expect(
      await code(await call("/" + product.id, "PATCH", { ...editable(product), isNew: false })),
    ).toBe("VERSION_CONFLICT");
    const audit = await db.auditLog.findMany({
      where: { entityId: product.id, action: "catalog.product_updated" },
    });
    expect(audit).toHaveLength(1);
    const diff = JSON.stringify(audit[0]!.diff);
    expect(diff).toContain("specsChanged");
    expect(diff).not.toContain("Synthetic description");
  });

  it("concurrent same-version edits have exactly one winner", async () => {
    const product = await create();
    const results = await Promise.allSettled(
      [5000, 5100, 5200, 5300].map((price) =>
        updateProduct(db, { actorId: ownerId, requestId: randomUUID() }, product.id, {
          ...editable(product),
          basePriceFils: price,
          compareAtPriceFils: null,
        } as never),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(CatalogueConflictError);
  });

  it("keeps published-state rules when editing a published product", async () => {
    const product = await create();
    await pool.query(
      "UPDATE products SET tax_treatment_ref='synthetic-vat',tax_treatment_version=1,status='published' WHERE id=$1",
      [product.id],
    );
    const current = await json(await call("/" + product.id));
    expect(current.taxTreatment).toEqual({ ref: "synthetic-vat", version: 1 });
    expect(
      await code(await call("/" + product.id, "PATCH", { ...editable(current), puffCount: null })),
    ).toBe("PUBLISH_REQUIREMENTS");
    expect(
      await code(
        await call("/" + product.id, "PATCH", {
          ...editable(current),
          basePriceFils: 0,
          compareAtPriceFils: null,
        }),
      ),
    ).toBe("PUBLISH_REQUIREMENTS");
    const moved = await parent("brand");
    await db.brand.update({ where: { id: moved.id }, data: { deletedAt: new Date() } });
    expect(
      await code(
        await call("/" + product.id, "PATCH", { ...editable(current), brandId: moved.id }),
      ),
    ).toBe("PARENT_UNAVAILABLE");
    // The edit never changed status: publication is a separate step-51 command.
    expect((await json(await call("/" + product.id))).status).toBe("published");
  });

  it("orders checks: not found and stale versions before parent availability", async () => {
    const product = await create();
    const trashed = await parent("brand");
    await db.brand.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
    expect(
      (await call("/" + randomUUID(), "PATCH", { ...editable(product), brandId: trashed.id }))
        .status,
    ).toBe(404);
    expect(
      await code(
        await call("/" + product.id, "PATCH", {
          ...editable(product),
          version: 9,
          brandId: trashed.id,
        }),
      ),
    ).toBe("VERSION_CONFLICT");
    // A draft keeps working after its own brand is trashed, as long as it stays there.
    const ownBrand = await parent("brand");
    const draft = await create({ brandId: ownBrand.id });
    await db.brand.update({ where: { id: ownBrand.id }, data: { deletedAt: new Date() } });
    const edited = await call("/" + draft.id, "PATCH", { ...editable(draft), isNew: false });
    expect(edited.status).toBe(200);
  });

  it("refuses SEO from Staff even when the value is unchanged", async () => {
    const product = await create();
    const response = await call(
      "/" + product.id,
      "PATCH",
      { ...editable(product), seo: { title: null, description: null } },
      cookies.staff,
    );
    expect(response.status).toBe(403);
  });

  it("serializes product edits with a concurrent brand trash", async () => {
    for (let round = 0; round < 5; round++) {
      const target = await parent("brand");
      const product = await create();
      const results = await Promise.allSettled([
        updateProduct(db, { actorId: ownerId, requestId: randomUUID() }, product.id, {
          ...editable(product),
          brandId: target.id,
        } as never),
        pool.query("UPDATE brands SET deleted_at=statement_timestamp() WHERE id=$1", [target.id]),
      ]);
      const [row] = (
        await pool.query(
          "SELECT p.brand_id, b.deleted_at FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.id=$1",
          [product.id],
        )
      ).rows as Array<{ brand_id: string; deleted_at: Date | null }>;
      // Either the move won before the trash, or it was refused after it; never a lost check.
      if (results[0]!.status === "rejected")
        expect(results[0]!.reason).toBeInstanceOf(CatalogueConflictError);
      else expect(row!.brand_id).toBe(target.id);
    }
  });

  it("lists with filters, literal search and a stable newest-first cursor", async () => {
    const otherCategory = await parent("category");
    const named = await create({ name: "Needle 100%_x " + seq++, categoryId: otherCategory.id });
    await create({ name: "Needle 100 other " + seq++ });
    const search = (await (await call("?q=" + encodeURIComponent("100%_"))).json()) as {
      items: ProductSummary[];
    };
    expect(search.items.map((item) => item.id)).toEqual([named.id]);
    const filtered = (await (await call("?categoryId=" + otherCategory.id)).json()) as {
      items: ProductSummary[];
    };
    expect(filtered.items.map((item) => item.id)).toEqual([named.id]);
    expect(filtered.items[0]).not.toHaveProperty("description");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await call("?limit=3&status=draft" + (cursor ? "&after=" + cursor : ""))
      ).json()) as { items: ProductSummary[]; nextCursor: string | null };
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(new Set(seen).size).toBe(seen.length);
    for (const bad of ["?limit=101", "?status=trashed", "?q=" + "x".repeat(101), "?after=1"])
      expect((await call(bad)).status).toBe(400);
  });

  it("denies a role without catalog.write", async () => {
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "catalog.write" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect((await call("", "POST", disposable(), cookies.staff)).status).toBe(403);
      expect((await call("?limit=1", "GET", undefined, cookies.staff)).status).toBe(200);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
  });
});
