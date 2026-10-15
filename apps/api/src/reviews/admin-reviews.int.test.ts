import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import {
  adminReviewsResponseSchema,
  errorEnvelopeSchema,
  reviewModerationResponseSchema,
  storeProductResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool, issueReviewLink, submitReview, transitionOrder } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import {
  AGE_COOKIE,
  ageTicketPublicKey,
  ageTicketSigner,
  Argon2PasswordHasher,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-admin-reviews-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const STORE = "http://localhost:8080";
const POLICY = "admin-reviews-test-1";
const PASSWORD = "copper-lantern-river-71";
const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
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
const ageCookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base = "";
let owner = "";
let staff = "";
let ownerId = "";
let host = 10;
const ip = () => `192.0.2.${(host = (host % 240) + 1)}`;
const admin = (path: string, cookie = owner, body?: unknown) =>
  fetch(`${base}/v1/admin/reviews${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": ip() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const decide = (id: string, decision: string, expectedVersion: number, cookie = owner) =>
  admin(`/${id}/moderation`, cookie, { decision, expectedVersion });
const productPage = async (slug: string) => {
  const response = await fetch(`${base}/v1/store/products/${slug}`, {
    headers: { cookie: ageCookie, "x-ih-client-ip": ip() },
  });
  expect(response.status).toBe(200);
  return storeProductResponseSchema.parse(await response.json());
};
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;

/** A visible product with a delivered order and a submitted (pending) review of it. */
async function pendingReview(rating = 4, title = "Smooth draw") {
  const seeded = await seedOrder(pool, { status: "confirmed" });
  for (const sql of [
    `UPDATE brands SET active=true WHERE id=(SELECT p.brand_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    `UPDATE categories SET active=true WHERE id=(SELECT p.category_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    "UPDATE products SET status='published' WHERE id=(SELECT product_id FROM variants WHERE id=$1)",
  ])
    await pool.query(sql, [seeded.variantId]);
  const command = { requestId: randomUUID(), actorId: ownerId };
  for (const to of ["processing", "out_for_delivery", "delivered"] as const) {
    const { version } = await one<{ version: number }>("SELECT version FROM orders WHERE id=$1", [
      seeded.orderId,
    ]);
    await transitionOrder(db, command, seeded.orderId, {
      to,
      expectedVersion: version,
      commandId: randomUUID(),
    });
  }
  const product = await one<{ id: string; slug: string }>(
    `SELECT p.id, p.slug FROM order_items i JOIN products p ON p.id=i.product_id
     WHERE i.order_id=$1`,
    [seeded.orderId],
  );
  const { link } = await issueReviewLink(db, command, seeded.orderId);
  await submitReview(db, {
    token: link.slice(link.indexOf("#") + 1),
    productId: product.id,
    rating,
    title,
    body: "Flavour lasted the whole week.",
    authorName: "Sam R.",
    requestId: randomUUID(),
  });
  const review = await one<{ id: string }>("SELECT id FROM reviews WHERE order_id=$1", [
    seeded.orderId,
  ]);
  return { ...seeded, productId: product.id, slug: product.slug, reviewId: review.id };
}

describe("review moderation and public reviews through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: "Moderation " + key,
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
      return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login("owner", "moderation-owner@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = (await login("staff", "moderation-staff@iqoshaven.test")).cookie;
    await db.setting.create({
      data: {
        key: "store",
        value: { name: "Iqos Haven", domain: "shop.iqoshaven.test", legalName: null },
        updatedBy: ownerId,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("is for moderators only, from the admin origin, with valid input", async () => {
    const { reviewId } = await pendingReview();
    expect((await admin("", staff)).status).toBe(403);
    expect((await decide(reviewId, "approve", 1, staff)).status).toBe(403);
    expect((await admin("", "")).status).toBe(401);
    const foreign = await fetch(`${base}/v1/admin/reviews/${reviewId}/moderation`, {
      method: "POST",
      headers: {
        cookie: owner,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve", expectedVersion: 1 }),
    });
    expect(foreign.status).toBe(403);
    for (const path of ["?status=hidden", "?rating=6", "?productId=1", "?after=!!", "?limit=500"])
      expect((await admin(path)).status, path).toBe(400);
    expect((await admin("?after=" + Buffer.from("[1,2]").toString("base64url"))).status).toBe(400);
    for (const body of [
      { decision: "publish", expectedVersion: 1 },
      { decision: "approve" },
      { decision: "approve", expectedVersion: 0 },
      { decision: "approve", expectedVersion: 1, status: "approved" },
    ])
      expect((await admin(`/${reviewId}/moderation`, owner, body)).status).toBe(400);
    expect(
      (await admin(`/not-a-uuid/moderation`, owner, { decision: "approve", expectedVersion: 1 }))
        .status,
    ).toBe(400);
    expect((await decide(randomUUID(), "approve", 1)).status).toBe(404);
    expect(await one("SELECT status FROM reviews WHERE id=$1", [reviewId])).toEqual({
      status: "pending",
    });
  });

  it("shows only approved reviews in public, verified, without the order", async () => {
    const { reviewId, slug, orderId, orderNumber } = await pendingReview(4);
    // Pending: nothing public (and the product page is now cached).
    const before = await productPage(slug);
    expect(before.rating).toBeNull();
    expect(before.reviews).toEqual([]);

    const approved = await decide(reviewId, "approve", 1);
    expect(approved.status).toBe(200);
    expect(reviewModerationResponseSchema.parse(await approved.json())).toMatchObject({
      id: reviewId,
      status: "approved",
      version: 2,
    });
    // The cached page was dropped after the commit.
    const after = await productPage(slug);
    expect(after.rating).toEqual({ average: 4, count: 1, distribution: [0, 1, 0, 0, 0] });
    expect(after.reviews).toEqual([
      {
        rating: 4,
        title: "Smooth draw",
        body: "Flavour lasted the whole week.",
        authorName: "Sam R.",
        date: expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
        verified: true,
      },
    ]);
    const text = JSON.stringify(after);
    for (const leak of [orderId, reviewId, String(orderNumber)]) expect(text).not.toContain(leak);

    // A stale decision and a repeated one are refused; nothing changes.
    expect(await errorCode(await decide(reviewId, "reject", 1))).toBe("VERSION_CONFLICT");
    expect(await errorCode(await decide(reviewId, "approve", 2))).toBe("INVALID_TRANSITION");

    // Hiding an approved review takes it off the page again.
    expect((await decide(reviewId, "reject", 2)).status).toBe(200);
    const hidden = await productPage(slug);
    expect(hidden.rating).toBeNull();
    expect(hidden.reviews).toEqual([]);

    const row = await one<Record<string, unknown>>(
      "SELECT status, version, title, moderated_by FROM reviews WHERE id=$1",
      [reviewId],
    );
    expect(row).toEqual({
      status: "rejected",
      version: 3,
      title: "Smooth draw",
      moderated_by: ownerId,
    });
    const audits = await pool.query(
      "SELECT action FROM audit_log WHERE entity_type='review' AND entity_id=$1 ORDER BY occurred_at",
      [reviewId],
    );
    expect(audits.rows.map((audit: { action: string }) => audit.action)).toEqual([
      "review.submitted",
      "review.approved",
      "review.rejected",
    ]);
    const events = await db.outboxEvent.count({
      where: {
        eventType: "catalog.changed",
        aggregateId: (
          await one<{ product_id: string }>("SELECT product_id FROM reviews WHERE id=$1", [
            reviewId,
          ])
        ).product_id,
      },
    });
    expect(events).toBe(2);
  });

  it("averages approved reviews only, per product and in the admin summary", async () => {
    const five = await pendingReview(5, "Great kit");
    const two = await pendingReview(2, "Leaked once");
    const one_ = await pendingReview(1, "Broke");
    expect((await decide(five.reviewId, "approve", 1)).status).toBe(200);
    expect((await decide(two.reviewId, "approve", 1)).status).toBe(200);
    expect((await decide(one_.reviewId, "reject", 1)).status).toBe(200);
    const page = await productPage(five.slug);
    expect(page.rating).toEqual({ average: 5, count: 1, distribution: [1, 0, 0, 0, 0] });
    expect((await productPage(one_.slug)).rating).toBeNull();
    const summary = adminReviewsResponseSchema.parse(await (await admin("?limit=1")).json());
    // Only the 5 and the 2 are approved at this point (earlier cases ended pending or rejected).
    expect(summary.approvedAverage).toBe(3.5);
    expect(summary.counts.approved).toBe(2);
  });

  it("lists for moderation with counts, filters, order link and pages", async () => {
    const a = await pendingReview(3, "Okay");
    const b = await pendingReview(1, "Not for me");
    const response = await admin("?status=pending&limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const list = adminReviewsResponseSchema.parse(await response.json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: b.reviewId, status: "pending", verified: true });
    expect(list.items[0]!.order?.id).toBe(b.orderId);
    expect(list.counts.pending).toBeGreaterThanOrEqual(2);
    expect(list.approvedAverage).not.toBeNull();
    const next = adminReviewsResponseSchema.parse(
      await (await admin(`?status=pending&limit=1&after=${list.nextCursor}`)).json(),
    );
    expect(next.items[0]!.id).toBe(a.reviewId);
    const byRating = adminReviewsResponseSchema.parse(await (await admin("?rating=1")).json());
    expect(byRating.items.every((item) => item.rating === 1)).toBe(true);
    const byProduct = adminReviewsResponseSchema.parse(
      await (await admin(`?productId=${a.productId}`)).json(),
    );
    expect(byProduct.items.map((item) => item.id)).toEqual([a.reviewId]);
    expect(list.products.map((product) => product.id)).toContain(a.productId);
  });

  it("takes one of two simultaneous decisions on the same version", async () => {
    const { reviewId } = await pendingReview();
    const results = await Promise.all([
      decide(reviewId, "approve", 1),
      decide(reviewId, "reject", 1),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await one("SELECT version FROM reviews WHERE id=$1", [reviewId])).toEqual({
      version: 2,
    });
  });
});
