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
import { createDatabase, createPool, stockReconciliationMismatches } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { productAvailability } from "@ih/domain";
import { Argon2PasswordHasher } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CatalogueCacheService } from "../cache/catalogue-cache.service";

/**
 * Catalogue/inventory acceptance pass (roadmap step 54). Module tests cover each rule in depth;
 * this file walks the cross-module cases the roadmap names, through the real API: SKU conflicts,
 * option sold-out, mixed concurrent stock changes and cache propagation. Upload, processing and
 * purge safety are covered in media/gallery/publication tests and the browser QA journey.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-catalogue-acceptance-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
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
let cache: CatalogueCacheService;
let cookie = "";
let brandId = "";
let categoryId = "";
let loads = 0;

const api = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const sku = () => "ACC-" + randomUUID().slice(0, 8).toUpperCase();
const unique = () => randomUUID().slice(0, 8);
/** Stands in for a store catalogue read (step 58): a new value after every invalidation. */
const cached = () => cache.getOrLoad("acceptance", () => Promise.resolve(++loads));

async function draftProduct() {
  const response = await api("/products", "POST", {
    name: "Acceptance product " + unique(),
    slug: "acceptance-" + unique(),
    brandId,
    categoryId,
    type: "disposable",
    puffCount: 7000,
    basePriceFils: 4900,
    compareAtPriceFils: null,
    description: "Synthetic description",
    isNew: false,
    specs: { liquidMl: "12.5", batteryMah: 650, rechargeable: true, charging: "USB-C", extra: [] },
  });
  if (response.status !== 201) throw new Error("product: " + (await response.text()));
  return ((await response.json()) as { id: string }).id;
}
async function flavours(productId: string, values: string[]) {
  const response = await api(`/products/${productId}/options`, "PUT", {
    productVersion: 1,
    options: [{ name: "flavour", values }],
  });
  expect(response.status).toBe(200);
}
const addVariant = (productId: string, flavour: string, overrides: Record<string, unknown> = {}) =>
  api(`/products/${productId}/variants`, "POST", {
    sku: sku(),
    attributes: { flavour },
    priceOverrideFils: null,
    lowStockThreshold: 2,
    active: true,
    ...overrides,
  });
const variantsOf = async (productId: string) =>
  ((await (await api(`/products/${productId}/variants`)).json()) as ProductVariantsResponse)
    .variants;
const adjust = (variantId: string, delta: number) =>
  api(`/inventory/${variantId}/adjustments`, "POST", {
    commandId: randomUUID(),
    delta,
    ...(delta > 0 ? { reason: "RESTOCK" } : { reason: "DAMAGE", note: "Synthetic removal" }),
  });
const set = (variantId: string, expected: number, target: number) =>
  api(`/inventory/${variantId}/set`, "POST", {
    commandId: randomUUID(),
    expectedStockOnHand: expected,
    targetStockOnHand: target,
    note: "Synthetic count",
  });

describe("catalogue and inventory acceptance through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    const staff = await db.staffUser.create({
      data: {
        email: "acceptance@iqoshaven.test",
        name: "Acceptance Person",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cache = app.get(CatalogueCacheService);
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
      body: JSON.stringify({ email: staff.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const created = async (path: string, name: string) => {
      const response = await api(path, "POST", { name, slug: "acc-" + unique(), active: true });
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    brandId = await created("/brands", "Acceptance brand");
    categoryId = await created("/categories", "Acceptance category");
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses a SKU already used anywhere, on create, on edit and under concurrency", async () => {
    const [first, second] = [await draftProduct(), await draftProduct()];
    await flavours(first, ["grape", "mint"]);
    await flavours(second, ["grape", "mint"]);
    const taken = sku();
    expect((await addVariant(first, "grape", { sku: taken })).status).toBe(201);
    // Another product, different case: still the same SKU.
    const clash = await addVariant(second, "grape", { sku: taken.toLowerCase() });
    expect(clash.status).toBe(409);
    expect(await code(clash)).toBe("DUPLICATE");
    // Renaming an existing variant onto a taken SKU is refused and changes nothing.
    expect((await addVariant(second, "mint")).status).toBe(201);
    const [mint] = await variantsOf(second);
    const rename = await api(`/products/${second}/variants/${mint!.id}`, "PATCH", {
      version: mint!.version,
      sku: taken,
      priceOverrideFils: null,
      lowStockThreshold: mint!.lowStockThreshold,
      active: true,
      isDefault: mint!.isDefault,
    });
    expect(await code(rename)).toBe("DUPLICATE");
    expect((await variantsOf(second))[0]).toMatchObject({ sku: mint!.sku, version: mint!.version });
    // Two products racing for one new SKU: exactly one gets it.
    const raced = sku();
    const [third, fourth] = [await draftProduct(), await draftProduct()];
    await flavours(third, ["grape"]);
    await flavours(fourth, ["grape"]);
    const statuses = await Promise.all(
      [third, fourth].map(async (id) => (await addVariant(id, "grape", { sku: raced })).status),
    );
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await db.variant.count({ where: { sku: raced } })).toBe(1);
  });

  it("shows one option sold out while the other sells, then the product sold out, still listed", async () => {
    const productId = await draftProduct();
    await flavours(productId, ["grape", "mint"]);
    expect((await addVariant(productId, "grape")).status).toBe(201);
    expect((await addVariant(productId, "mint")).status).toBe(201);
    const [grape, mint] = (await variantsOf(productId)).sort((a, b) =>
      a.attributes.flavour!.localeCompare(b.attributes.flavour!),
    );
    expect((await adjust(mint!.id, 3)).status).toBe(200);
    let availability = productAvailability(await variantsOf(productId));
    expect(availability).toEqual({ soldOut: false, availableVariantIds: [mint!.id] });
    const states = async () => {
      const page = (await (await api(`/inventory?productId=${productId}`)).json()) as {
        items: Array<{ variantId: string; stockState: string }>;
      };
      return Object.fromEntries(page.items.map((item) => [item.variantId, item.stockState]));
    };
    expect(await states()).toMatchObject({ [grape!.id]: "out", [mint!.id]: "in_stock" });
    // Selling the last units of the remaining option: sold out, never removed or deactivated.
    expect((await adjust(mint!.id, -3)).status).toBe(200);
    availability = productAvailability(await variantsOf(productId));
    expect(availability).toEqual({ soldOut: true, availableVariantIds: [] });
    expect(await states()).toMatchObject({ [grape!.id]: "out", [mint!.id]: "out" });
    expect((await variantsOf(productId)).every((variant) => variant.active)).toBe(true);
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).deletedAt).toBeNull();
    // Deactivating the only stocked option also makes the product sold out.
    expect((await adjust(grape!.id, 5)).status).toBe(200);
    expect(productAvailability(await variantsOf(productId)).soldOut).toBe(false);
    const stocked = (await variantsOf(productId)).map((variant) =>
      variant.id === grape!.id ? { ...variant, active: false } : variant,
    );
    expect(productAvailability(stocked).soldOut).toBe(true);
  });

  it("keeps ledger and balance equal when adjustments and counted sets race", async () => {
    const productId = await draftProduct();
    await flavours(productId, ["grape"]);
    expect((await addVariant(productId, "grape", { lowStockThreshold: 15 })).status).toBe(201);
    const [variant] = await variantsOf(productId);
    expect((await adjust(variant!.id, 20)).status).toBe(200);
    const responses = await Promise.all([
      ...Array.from({ length: 6 }, () => adjust(variant!.id, -1)),
      ...Array.from({ length: 3 }, () => set(variant!.id, 20, 12)),
      ...Array.from({ length: 3 }, () => adjust(variant!.id, 2)),
    ]);
    const outcomes = await Promise.all(
      responses.map(async (response) => (response.status === 200 ? "ok" : await code(response))),
    );
    // Every command either applied or was refused for a stale view; nothing failed otherwise.
    expect(new Set(outcomes)).toEqual(
      new Set(outcomes.includes("STOCK_CHANGED") ? ["ok", "STOCK_CHANGED"] : ["ok"]),
    );
    // A set only applies to the balance its user saw, so at most one of the three can win.
    expect(outcomes.slice(6, 9).filter((outcome) => outcome === "ok").length).toBeLessThanOrEqual(
      1,
    );
    const movements = await db.stockMovement.findMany({
      where: { variantId: variant!.id },
      orderBy: { id: "asc" },
    });
    const balance = (await db.variant.findUniqueOrThrow({ where: { id: variant!.id } }))
      .stockOnHand;
    expect(movements.reduce((sum, movement) => sum + movement.delta, 0)).toBe(balance);
    expect(movements.at(-1)!.balanceAfter).toBe(balance);
    // Each movement's recorded balance continues from the previous one: no lost update.
    let running = 0;
    for (const movement of movements) {
      running += movement.delta;
      expect(movement.balanceAfter).toBe(running);
    }
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    // One alert at most per excursion below the threshold of 15.
    const crossings = movements.filter(
      (movement) => movement.balanceAfter - movement.delta > 15 && movement.balanceAfter <= 15,
    ).length;
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: variant!.id, eventType: "inventory.low" },
      }),
    ).toBe(crossings);
  });

  it("propagates every kind of catalogue change to the cache and queues its durable retry", async () => {
    const productId = await draftProduct();
    const changes: Array<[string, () => Promise<Response>, number]> = [
      [
        "brand",
        () =>
          api("/brands", "POST", { name: "B " + unique(), slug: "b-" + unique(), active: true }),
        201,
      ],
      [
        "category",
        () =>
          api("/categories", "POST", {
            name: "C " + unique(),
            slug: "c-" + unique(),
            active: true,
          }),
        201,
      ],
      ["product", () => draftProduct().then(() => new Response(null, { status: 201 })), 201],
      [
        "options",
        () =>
          api(`/products/${productId}/options`, "PUT", {
            productVersion: 1,
            options: [{ name: "flavour", values: ["grape"] }],
          }),
        200,
      ],
      ["variant", () => addVariant(productId, "grape"), 201],
    ];
    for (const [name, change, status] of changes) {
      const before = await cached();
      expect(await cached(), name).toBe(before);
      const events = await db.consumerEffect.count({
        where: { consumer: "storefront_revalidate" },
      });
      expect((await change()).status, name).toBe(status);
      expect(await cached(), name).not.toBe(before);
      expect(
        await db.consumerEffect.count({ where: { consumer: "storefront_revalidate" } }),
        name,
      ).toBeGreaterThan(events);
    }
    // Reads never invalidate.
    const before = await cached();
    expect((await api("/products")).status).toBe(200);
    expect((await api(`/products/${productId}/variants`)).status).toBe(200);
    expect(await cached()).toBe(before);
  });
});
