import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { storeEventsResponseSchema } from "@ih/contracts";
import { createDatabase, createPool, deleteExpiredBrowsingEvents } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { AGE_COOKIE, ageTicketPublicKey, ageTicketSigner, signAgeTicket } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-store-events-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "store-events-test-1";
const STORE = "http://localhost:8080";
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
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
  STOREFRONT_ORIGINS: STORE,
});
const cookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base = "";
let host = 10;
const post = (
  body: unknown,
  headers: Record<string, string> = { cookie, origin: STORE },
  ip = `198.51.100.${(host = (host % 240) + 1)}`,
) =>
  fetch(`${base}/v1/store/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ih-client-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const answer = async (response: Response) => {
  expect(response.status).toBe(202);
  return storeEventsResponseSchema.parse(await response.json());
};
const id = () => randomUUID();

/** A visible product with an active variant, and its slug. */
async function visibleProduct() {
  const { variantId } = await seedOrder(pool);
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.brand_id AS "brandId", p.category_id AS "categoryId"
     FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=$1`,
    [variantId],
  );
  const product = rows[0] as { id: string; slug: string; brandId: string; categoryId: string };
  await pool.query("UPDATE brands SET active=true WHERE id=$1", [product.brandId]);
  await pool.query("UPDATE categories SET active=true WHERE id=$1", [product.categoryId]);
  await pool.query("UPDATE products SET status='published' WHERE id=$1", [product.id]);
  return { ...product, variantId };
}

describe("anonymous browsing events through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
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

  it("answers nothing without an age ticket, from another origin, or as a form", async () => {
    const batch = { events: [{ id: id(), type: "search", term: "grape", resultCount: 1 }] };
    expect((await post(batch, { origin: STORE })).status).toBe(403);
    expect((await post(batch, { cookie, origin: "https://evil.example" })).status).toBe(403);
    const form = await fetch(`${base}/v1/store/events`, {
      method: "POST",
      headers: { cookie, origin: STORE, "content-type": "text/plain" },
      body: JSON.stringify(batch),
    });
    expect(form.status).toBe(415);
    expect(await db.browsingEvent.count()).toBe(0);
  });

  it("stores the six types with IDs resolved and nothing that identifies the shopper", async () => {
    const product = await visibleProduct();
    const anonymousId = id();
    const result = await answer(
      await post({
        anonymousId,
        events: [
          { id: id(), type: "search", term: "  Grape  ICE ", resultCount: 4 },
          { id: id(), type: "search", term: "+971 50 123 4567", resultCount: 0 },
          { id: id(), type: "product_view", productSlug: product.slug },
          { id: id(), type: "cart_add", variantId: product.variantId, quantity: 2 },
          { id: id(), type: "cart_remove", variantId: product.variantId, quantity: 1 },
          { id: id(), type: "wishlist_add", productSlug: product.slug },
          { id: id(), type: "wishlist_remove", productSlug: product.slug },
        ],
      }),
    );
    expect(result).toEqual({ stored: 7, duplicate: 0, dropped: 0 });
    const rows = await db.browsingEvent.findMany({ orderBy: { receivedAt: "asc" } });
    const payloads = rows.map((row) => [row.type, row.payload]);
    expect(payloads).toContainEqual(["search", { term: "grape ice", resultCount: 4 }]);
    // A term that looks like a phone number is counted, never kept.
    expect(payloads).toContainEqual(["search", { term: null, resultCount: 0 }]);
    expect(payloads).toContainEqual(["product_view", { productId: product.id }]);
    expect(payloads).toContainEqual([
      "cart_add",
      { productId: product.id, variantId: product.variantId, quantity: 2 },
    ]);
    // Searches are never linked to the browser's other events.
    for (const row of rows)
      expect(row.anonymousId).toBe(row.type === "search" ? null : anonymousId);
    const text = JSON.stringify(rows);
    for (const personal of ["971", "4567", "198.51.100", "cookie"])
      expect(text).not.toContain(personal);
  });

  it("counts a resent event once and drops what a shopper cannot see", async () => {
    const product = await visibleProduct();
    const hidden = await visibleProduct();
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [hidden.id]);
    const repeated = { id: id(), type: "product_view", productSlug: product.slug };
    expect(await answer(await post({ events: [repeated] }))).toEqual({
      stored: 1,
      duplicate: 0,
      dropped: 0,
    });
    expect(
      await answer(
        await post({
          events: [
            repeated,
            { id: id(), type: "product_view", productSlug: hidden.slug },
            { id: id(), type: "cart_add", variantId: hidden.variantId, quantity: 1 },
            { id: id(), type: "wishlist_add", productSlug: "no-such-product" },
          ],
        }),
      ),
    ).toEqual({ stored: 0, duplicate: 1, dropped: 3 });
    // A former slug still counts for the product it now redirects to.
    await pool.query(
      "INSERT INTO slug_redirects (entity_type, old_slug, product_id) VALUES ('product', $1, $2)",
      ["old-" + product.slug, product.id],
    );
    expect(
      (
        await answer(
          await post({
            events: [{ id: id(), type: "product_view", productSlug: "old-" + product.slug }],
          }),
        )
      ).stored,
    ).toBe(1);
  });

  it("refuses batches that are too many, too large or not in the contract", async () => {
    const view = () => ({ id: id(), type: "product_view", productSlug: "x" });
    expect((await post({ events: Array.from({ length: 21 }, view) })).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: [{ ...view(), phone: "0501234567" }] })).status).toBe(400);
    expect((await post({ events: [view()], name: "Sam" })).status).toBe(400);
    expect(
      (await post({ events: [{ id: id(), type: "order_placed", orderId: id() }] })).status,
    ).toBe(400);
    const large = JSON.stringify({ events: [view()], padding: "x".repeat(9000) });
    const tooLarge = await post(large);
    expect(tooLarge.status).toBe(413);
  });

  it("limits batches per address", async () => {
    const ip = "203.0.113.90";
    const statuses: number[] = [];
    for (let n = 0; n < 61; n += 1)
      statuses.push(
        (
          await post(
            { events: [{ id: id(), type: "search", term: "x", resultCount: 0 }] },
            undefined,
            ip,
          )
        ).status,
      );
    expect(statuses.slice(0, 60).every((status) => status === 202)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("removes raw events after 90 days, in batches", async () => {
    const old = id();
    await pool.query(
      `INSERT INTO events (id, type, payload, received_at)
       VALUES ($1, 'search', '{"term":"old","resultCount":0}', now() - interval '91 days')`,
      [old],
    );
    const before = await db.browsingEvent.count();
    expect(await deleteExpiredBrowsingEvents(db, 10)).toBe(1);
    expect(await db.browsingEvent.count()).toBe(before - 1);
    expect(await db.browsingEvent.findUnique({ where: { id: old } })).toBeNull();
    expect(await deleteExpiredBrowsingEvents(db, 10)).toBe(0);
  });
});
