import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { ProductVariantsResponse } from "@ih/contracts";
import { createDatabase, createPool, createVariant, CatalogueConflictError } from "@ih/db";
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
  applicationName: "ih-variants-test",
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
      email: `variants${seq++}@iqoshaven.test`,
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
const snapshot = async (response: Response) => (await response.json()) as ProductVariantsResponse;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const sku = () => "SKU-" + randomUUID().slice(0, 8).toUpperCase();
async function product() {
  return db.product.create({
    data: {
      name: "Variant product " + seq++,
      slug: "variant-product-" + randomUUID().slice(0, 8),
      brandId,
      categoryId,
      type: "disposable",
      basePriceFils: 4900n,
    },
  });
}
const variant = (attributes: Record<string, string>, overrides: Record<string, unknown> = {}) => ({
  sku: sku(),
  attributes,
  priceOverrideFils: null,
  lowStockThreshold: 5,
  active: true,
  ...overrides,
});
async function withOptions(options: Array<{ name: string; values: string[] }>) {
  const row = await product();
  const response = await call(`/${row.id}/options`, "PUT", { productVersion: 1, options });
  expect(response.status).toBe(200);
  return row.id;
}

describe("product options and variants through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
    brandId = (await db.brand.create({ data: { name: "Variant brand", slug: "variant-brand" } }))
      .id;
    categoryId = (
      await db.category.create({ data: { name: "Variant category", slug: "variant-category" } })
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

  it("gives a product without options exactly one default variant", async () => {
    const row = await product();
    const first = await call(`/${row.id}/variants`, "POST", variant({}), cookies.staff);
    expect(first.status).toBe(201);
    const view = await snapshot(first);
    expect(view.options).toEqual([]);
    expect(view.variants).toHaveLength(1);
    expect(view.variants[0]).toMatchObject({ isDefault: true, stockOnHand: 0, attributes: {} });
    expect(await code(await call(`/${row.id}/variants`, "POST", variant({})))).toBe("DUPLICATE");
    // The first variant is the default, so it must be active.
    const other = await product();
    expect(
      await code(await call(`/${other.id}/variants`, "POST", variant({}, { active: false }))),
    ).toBe("DEFAULT_REQUIRED");
  });

  it("creates real option combinations with canonical values and exact coverage", async () => {
    const id = await withOptions([
      { name: "flavour", values: ["Grape Ice", "Mint"] },
      { name: "nicotine", values: ["20 mg", "50 mg"] },
    ]);
    const created = await snapshot(
      await call(`/${id}/variants`, "POST", variant({ flavour: "GRAPE ICE", nicotine: "20 mg" })),
    );
    expect(created.options).toEqual([
      { name: "flavour", values: ["grape ice", "mint"] },
      { name: "nicotine", values: ["20 mg", "50 mg"] },
    ]);
    expect(created.variants[0]!.attributes).toEqual({ flavour: "grape ice", nicotine: "20 mg" });
    for (const attributes of <Array<Record<string, string>>>[
      { flavour: "grape ice" },
      { flavour: "grape ice", nicotine: "30 mg" },
      { flavour: "grape ice", nicotine: "20 mg", colour: "red" },
      {},
    ])
      expect(await code(await call(`/${id}/variants`, "POST", variant(attributes)))).toBe(
        "INVALID_COMBINATION",
      );
    // Same combination with different key order or case is the same signature.
    expect(
      await code(
        await call(`/${id}/variants`, "POST", variant({ nicotine: "20 mg", flavour: "Grape Ice" })),
      ),
    ).toBe("DUPLICATE");
    const second = await snapshot(
      await call(`/${id}/variants`, "POST", variant({ flavour: "mint", nicotine: "50 mg" })),
    );
    expect(second.variants.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it("keeps SKUs global, uppercase and unique", async () => {
    const id = await withOptions([{ name: "colour", values: ["black", "blue"] }]);
    const taken = sku();
    await call(
      `/${id}/variants`,
      "POST",
      variant({ colour: "black" }, { sku: taken.toLowerCase() }),
    );
    const view = await snapshot(await call(`/${id}/variants`));
    expect(view.variants[0]!.sku).toBe(taken);
    const other = await withOptions([{ name: "colour", values: ["black"] }]);
    expect(
      await code(
        await call(`/${other}/variants`, "POST", variant({ colour: "black" }, { sku: taken })),
      ),
    ).toBe("DUPLICATE");
    for (const bad of ["", "has space", "x".repeat(65), "-LEADING"])
      expect(
        (await call(`/${id}/variants`, "POST", variant({ colour: "blue" }, { sku: bad }))).status,
      ).toBe(400);
  });

  it("protects option structure and used values once variants exist", async () => {
    const id = await withOptions([{ name: "flavour", values: ["mint", "grape"] }]);
    await call(`/${id}/variants`, "POST", variant({ flavour: "mint" }));
    const version = (await snapshot(await call(`/${id}/variants`))).productVersion;
    const put = (options: unknown, productVersion = version) =>
      call(`/${id}/options`, "PUT", { productVersion, options });
    expect(
      await code(
        await put([
          { name: "flavour", values: ["mint", "grape"] },
          { name: "nicotine", values: ["20 mg"] },
        ]),
      ),
    ).toBe("OPTIONS_IN_USE");
    expect(await code(await put([{ name: "flavour", values: ["grape"] }]))).toBe("OPTIONS_IN_USE");
    // Adding values and removing unused ones is fine.
    const grown = await snapshot(await put([{ name: "flavour", values: ["mint", "peach"] }]));
    expect(grown.options[0]!.values).toEqual(["mint", "peach"]);
    expect(grown.productVersion).toBe(version + 1);
    expect(await code(await put([{ name: "flavour", values: ["mint"] }], version))).toBe(
      "VERSION_CONFLICT",
    );
    for (const options of [
      [{ name: "size", values: ["x"] }],
      [{ name: "flavour", values: ["mint", "MINT"] }],
      [{ name: "flavour", values: [] }],
      [
        { name: "flavour", values: ["a"] },
        { name: "flavour", values: ["b"] },
      ],
    ])
      expect((await put(options, version + 1)).status).toBe(400);
  });

  it("moves the default atomically and never leaves it inactive or missing", async () => {
    const id = await withOptions([{ name: "colour", values: ["black", "blue"] }]);
    await call(`/${id}/variants`, "POST", variant({ colour: "black" }));
    const view = await snapshot(await call(`/${id}/variants`, "POST", variant({ colour: "blue" })));
    const [black, blue] = view.variants as [
      ProductVariantsResponse["variants"][number],
      ProductVariantsResponse["variants"][number],
    ];
    const edit = (v: typeof black, overrides: Record<string, unknown>) =>
      call(`/${id}/variants/${v.id}`, "PATCH", {
        version: v.version,
        sku: v.sku,
        priceOverrideFils: v.priceOverrideFils,
        lowStockThreshold: v.lowStockThreshold,
        active: v.active,
        isDefault: v.isDefault,
        ...overrides,
      });
    expect(await code(await edit(black, { isDefault: false }))).toBe("DEFAULT_REQUIRED");
    expect(await code(await edit(black, { active: false }))).toBe("DEFAULT_REQUIRED");
    expect(await code(await edit(blue, { isDefault: true, active: false }))).toBe(
      "DEFAULT_REQUIRED",
    );
    const moved = await snapshot(await edit(blue, { isDefault: true, priceOverrideFils: 5200 }));
    expect(moved.variants.map((v) => [v.id, v.isDefault])).toEqual([
      [black.id, false],
      [blue.id, true],
    ]);
    expect(moved.variants[1]!.priceOverrideFils).toBe(5200);
    // The old default can now be deactivated (never deleted).
    const oldDefault = moved.variants[0]!;
    expect((await snapshot(await edit(oldDefault, { active: false }))).variants[0]!.active).toBe(
      false,
    );
    expect(await code(await edit(black, { lowStockThreshold: 9 }))).toBe("VERSION_CONFLICT");
    const audit = await db.auditLog.findMany({ where: { entityId: black.id } });
    expect(audit.map((a) => a.action)).toContain("catalog.variant_updated");
  });

  it("never lets stock be set through the variant API", async () => {
    const row = await product();
    const response = await call(`/${row.id}/variants`, "POST", variant({}, { stockOnHand: 10 }));
    expect(response.status).toBe(400);
    const created = await snapshot(await call(`/${row.id}/variants`, "POST", variant({})));
    const v = created.variants[0]!;
    const patched = await call(`/${row.id}/variants/${v.id}`, "PATCH", {
      version: v.version,
      sku: v.sku,
      priceOverrideFils: null,
      lowStockThreshold: 3,
      active: true,
      isDefault: true,
      stockOnHand: 99,
    });
    expect(patched.status).toBe(400);
  });

  it("serializes concurrent first variants so exactly one becomes the default", async () => {
    const id = await withOptions([{ name: "colour", values: ["a", "b", "c", "d"] }]);
    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((colour) =>
        createVariant(db, { actorId: ownerId, requestId: randomUUID() }, id, variant({ colour })),
      ),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const view = await snapshot(await call(`/${id}/variants`));
    expect(view.variants).toHaveLength(4);
    expect(view.variants.filter((v) => v.isDefault)).toHaveLength(1);
    await expect(
      createVariant(
        db,
        { actorId: ownerId, requestId: randomUUID() },
        id,
        variant({ colour: "a" }),
      ),
    ).rejects.toBeInstanceOf(CatalogueConflictError);
  });

  it("records audit and a product-level catalog.changed event for every change", async () => {
    const id = await withOptions([{ name: "colour", values: ["black"] }]);
    const created = await snapshot(
      await call(`/${id}/variants`, "POST", variant({ colour: "black" })),
    );
    const variantId = created.variants[0]!.id;
    const audit = await db.auditLog.findMany({ where: { entityId: { in: [id, variantId] } } });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "catalog.product_options_updated",
      "catalog.variant_created",
    ]);
    expect(JSON.stringify(audit.find((a) => a.entityId === id)!.diff)).toContain("black");
    const events = await db.outboxEvent.findMany({ where: { aggregateId: id } });
    expect(events.map((e) => e.payload)).toEqual([
      { entityType: "product", entityId: id },
      { entityType: "product", entityId: id },
    ]);
    expect(await db.outboxEvent.count({ where: { aggregateId: variantId } })).toBe(0);
  });

  it("refuses to add options once a single default variant exists", async () => {
    const row = await product();
    await call(`/${row.id}/variants`, "POST", variant({}));
    expect(
      await code(
        await call(`/${row.id}/options`, "PUT", {
          productVersion: 1,
          options: [{ name: "flavour", values: ["mint"] }],
        }),
      ),
    ).toBe("OPTIONS_IN_USE");
  });

  it("serializes option value removal against a variant using it", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await withOptions([{ name: "flavour", values: ["mint", "grape"] }]);
      await Promise.allSettled([
        createVariant(
          db,
          { actorId: ownerId, requestId: randomUUID() },
          id,
          variant({ flavour: "grape" }),
        ),
        call(`/${id}/options`, "PUT", {
          productVersion: 2,
          options: [{ name: "flavour", values: ["mint"] }],
        }),
      ]);
      const view = await snapshot(await call(`/${id}/variants`));
      const allowed = view.options[0]!.values;
      for (const v of view.variants) expect(allowed).toContain(v.attributes.flavour);
    }
  });

  it("enforces permissions, unknown products and trashed products", async () => {
    const row = await product();
    expect((await call(`/${randomUUID()}/variants`)).status).toBe(404);
    expect((await call(`/${row.id}/variants`, "GET", undefined, "")).status).toBe(401);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "catalog.write" } });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect((await call(`/${row.id}/variants`, "POST", variant({}), cookies.staff)).status).toBe(
        403,
      );
      expect((await call(`/${row.id}/variants`, "GET", undefined, cookies.staff)).status).toBe(200);
      expect(
        (await call(`/${row.id}/options`, "PUT", { productVersion: 1, options: [] }, cookies.staff))
          .status,
      ).toBe(403);
      expect(
        (
          await call(
            `/${row.id}/variants/${randomUUID()}`,
            "PATCH",
            {
              version: 1,
              sku: "X1",
              priceOverrideFils: null,
              lowStockThreshold: 0,
              active: true,
              isDefault: true,
            },
            cookies.staff,
          )
        ).status,
      ).toBe(403);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
    await db.product.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    expect(await code(await call(`/${row.id}/variants`, "POST", variant({})))).toBe("TRASHED");
    expect(
      await code(
        await call(`/${row.id}/options`, "PUT", {
          productVersion: 1,
          options: [{ name: "colour", values: ["red"] }],
        }),
      ),
    ).toBe("TRASHED");
  });
});
