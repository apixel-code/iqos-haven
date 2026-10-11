import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, stockReconciliationMismatches } from "@ih/db";
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
  applicationName: "ih-low-stock-test",
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
let productId = "";
/** Variant edits re-check publish requirements, so threshold edits use a draft product. */
let draftProductId = "";
let cookie = "";
let colour = 0;

const post = (path: string, method: string, body: unknown) =>
  fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      cookie,
      origin: ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": "192.0.2.2",
    },
    body: JSON.stringify(body),
  });
async function adjust(variantId: string, delta: number, commandId = randomUUID()) {
  const response = await post(`/inventory/${variantId}/adjustments`, "POST", {
    commandId,
    delta,
    ...(delta > 0 ? { reason: "RESTOCK" } : { reason: "DAMAGE", note: "Synthetic removal" }),
  });
  return response.status;
}
/** A variant with `stock` units already on hand; its opening movement crosses nothing. */
async function variant(threshold: number, stock: number, ofProduct = productId) {
  const row = await db.variant.create({
    data: {
      productId: ofProduct,
      sku: "LOW-" + randomUUID().slice(0, 8).toUpperCase(),
      attributes: { colour: "c" + colour++ },
      lowStockThreshold: threshold,
      active: true,
    },
  });
  if (stock > 0) expect(await adjust(row.id, stock)).toBe(200);
  return row;
}
const lowEvents = (variantId: string) =>
  db.outboxEvent.findMany({
    where: { aggregateId: variantId, eventType: "inventory.low" },
    orderBy: { createdAt: "asc" },
  });
const stockOf = async (variantId: string) =>
  (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand;

describe("variant low-stock transitions through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    const staff = await db.staffUser.create({
      data: {
        email: "lowstock@iqoshaven.test",
        name: "Stock Person",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    const brand = await db.brand.create({ data: { name: "Low brand", slug: "low-brand" } });
    const category = await db.category.create({
      data: { name: "Low category", slug: "low-category" },
    });
    productId = (
      await db.product.create({
        data: {
          name: "Low product",
          slug: "low-product",
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 1000n,
          taxTreatmentRef: "synthetic-vat",
          taxTreatmentVersion: 1,
          status: "published",
        },
      })
    ).id;
    draftProductId = (
      await db.product.create({
        data: {
          name: "Low draft product",
          slug: "low-draft-product",
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 1000n,
        },
      })
    ).id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
      body: JSON.stringify({ email: staff.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("emits once on crossing to the threshold, stays quiet while low, and re-arms above it", async () => {
    const v = await variant(3, 10);
    expect(await lowEvents(v.id)).toHaveLength(0);
    expect(await adjust(v.id, -6)).toBe(200); // 4: still above
    expect(await lowEvents(v.id)).toHaveLength(0);
    expect(await adjust(v.id, -1)).toBe(200); // 3: at the threshold
    const [first] = await lowEvents(v.id);
    expect(first).toMatchObject({
      aggregateType: "variant",
      payload: { variantId: v.id, cause: "stock" },
    });
    // IDs only: no stock figures, names or SKUs travel in the event.
    expect(Object.keys(first!.payload as object).sort()).toEqual(["cause", "variantId"]);
    expect(await adjust(v.id, -2)).toBe(200); // 1: lower while low
    expect(await adjust(v.id, 2)).toBe(200); // 3: partial restock, still low
    expect(await lowEvents(v.id)).toHaveLength(1);
    expect(await adjust(v.id, 5)).toBe(200); // 8: above, re-armed silently
    expect(await lowEvents(v.id)).toHaveLength(1);
    expect(await adjust(v.id, -8)).toBe(200); // 0: crosses again, straight past the threshold
    expect(await lowEvents(v.id)).toHaveLength(2);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("zero stock raises the alert but never unpublishes or deactivates", async () => {
    const v = await variant(0, 1);
    expect(await adjust(v.id, -1)).toBe(200);
    expect(await lowEvents(v.id)).toHaveLength(1);
    expect(await db.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({
      status: "published",
      deletedAt: null,
    });
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).active).toBe(true);
  });

  it("emits exactly once when concurrent removals cross together", async () => {
    const v = await variant(5, 12);
    const statuses = await Promise.all(Array.from({ length: 10 }, () => adjust(v.id, -1)));
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(await stockOf(v.id)).toBe(2);
    expect(await lowEvents(v.id)).toHaveLength(1);
  });

  it("does not emit again for a replayed or concurrently duplicated command", async () => {
    const v = await variant(5, 6);
    const commandId = randomUUID();
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => adjust(v.id, -1, commandId)),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(await adjust(v.id, -1, commandId)).toBe(200);
    expect(await stockOf(v.id)).toBe(5);
    expect(await lowEvents(v.id)).toHaveLength(1);
  });

  it("emits for a counted set, and rolls the event back with a refused one", async () => {
    const v = await variant(4, 9);
    const set = (expected: number, target: number) =>
      post(`/inventory/${v.id}/set`, "POST", {
        commandId: randomUUID(),
        expectedStockOnHand: expected,
        targetStockOnHand: target,
        note: "Synthetic count",
      });
    expect((await set(8, 2)).status).toBe(409); // stale view: nothing recorded
    expect(await lowEvents(v.id)).toHaveLength(0);
    expect((await set(9, 2)).status).toBe(200);
    expect((await set(2, 2)).status).toBe(200); // no movement
    expect(await lowEvents(v.id)).toHaveLength(1);
  });

  it("re-evaluates a threshold edit once, without repeating while already low", async () => {
    const v = await variant(2, 6, draftProductId);
    const edit = async (lowStockThreshold: number) => {
      const row = await db.variant.findUniqueOrThrow({ where: { id: v.id } });
      const response = await post(`/products/${draftProductId}/variants/${v.id}`, "PATCH", {
        version: row.version,
        sku: row.sku,
        priceOverrideFils: null,
        lowStockThreshold,
        active: row.active,
        isDefault: row.isDefault,
      });
      expect(response.status).toBe(200);
      return row.version + 1;
    };
    await edit(4); // 6 > 4: still above
    expect(await lowEvents(v.id)).toHaveLength(0);
    const version = await edit(6); // threshold reaches the stock
    const [event] = await lowEvents(v.id);
    expect(event).toMatchObject({
      payload: { variantId: v.id, cause: "threshold" },
      aggregateVersion: BigInt(version),
    });
    await edit(9); // already low: no repeat
    expect(await adjust(v.id, -1)).toBe(200); // still low
    expect(await lowEvents(v.id)).toHaveLength(1);
    await edit(1); // 5 > 1: re-armed by the threshold
    expect(await adjust(v.id, -4)).toBe(200); // 1: crosses by stock
    const events = await lowEvents(v.id);
    expect(events.map((row) => (row.payload as { cause: string }).cause)).toEqual([
      "threshold",
      "stock",
    ]);
  });

  it("writes the event in the same transaction as the movement and its audit entry", async () => {
    const v = await variant(3, 4);
    expect(await adjust(v.id, -1)).toBe(200);
    const [event] = await lowEvents(v.id);
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { variantId: v.id },
      orderBy: { id: "desc" },
    });
    // Same inserting transaction ID: one commit produced both rows.
    const { rows } = await pool.query<{ same: boolean }>(
      `SELECT (SELECT xmin FROM outbox_events WHERE id=$1) = (SELECT xmin FROM stock_movements WHERE id=$2) AS same`,
      [event!.id, movement.id],
    );
    expect(rows[0]?.same).toBe(true);
  });
});
