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
  errorEnvelopeSchema,
  storeReviewProofResponseSchema,
  storeReviewResponseSchema,
} from "@ih/contracts";
import {
  createDatabase,
  createPool,
  issueReviewLink,
  transitionOrder,
  withTransaction,
  writeReviewNotification,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { formatOrderNumber } from "@ih/domain";
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
  applicationName: "ih-store-reviews-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "reviews-test-1";
const STORE = "http://localhost:8080";
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
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
let ownerId = "";
let host = 10;
/** A fresh client address per call unless one is given, so limits never mix between cases. */
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { cookie, origin: STORE },
  ip = `198.51.100.${(host = (host % 240) + 1)}`,
) =>
  fetch(`${base}/v1/store/reviews${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ih-client-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const context = () => ({ requestId: randomUUID(), actorId: ownerId });

/** A Delivered order with one product and a live review link for it. */
async function deliveredWithLink() {
  const seeded = await seedOrder(pool, { status: "confirmed" });
  for (const to of ["processing", "out_for_delivery", "delivered"] as const) {
    const { version } = await one<{ version: number }>("SELECT version FROM orders WHERE id=$1", [
      seeded.orderId,
    ]);
    await transitionOrder(db, context(), seeded.orderId, {
      to,
      expectedVersion: version,
      commandId: randomUUID(),
    });
  }
  const { productId } = await one<{ productId: string }>(
    'SELECT product_id AS "productId" FROM order_items WHERE order_id=$1',
    [seeded.orderId],
  );
  const issued = await issueReviewLink(db, context(), seeded.orderId);
  const token = issued.link.slice(issued.link.indexOf("#") + 1);
  return { ...seeded, productId, token };
}
const review = (token: string, productId: string, extra: Record<string, unknown> = {}) => ({
  token,
  productId,
  rating: 4,
  title: "  Solid   kit ",
  body: "Lasts all day.\r\n\r\n\r\nWould buy again.",
  authorName: " Sam  R. ",
  ...extra,
});

describe("store review submission through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "reviews-owner@iqoshaven.test",
          name: "Reviews Owner",
          roleId: role.id,
          passwordHash: HASH,
        },
      })
    ).id;
    await db.setting.create({
      data: {
        key: "store",
        value: { name: "Iqos Haven", domain: "shop.iqoshaven.test", legalName: null },
        updatedBy: ownerId,
      },
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

  it("answers nothing without a valid age ticket, from another origin, or as a form", async () => {
    const { token, productId } = await deliveredWithLink();
    for (const headers of <Record<string, string>[]>[
      { origin: STORE },
      { origin: STORE, cookie: `${AGE_COOKIE}=accepted` },
      { origin: STORE, "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    ]) {
      const response = await post("/proof", { token }, headers);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("AGE_VERIFICATION_REQUIRED");
      expect((await post("", review(token, productId), headers)).status).toBe(403);
    }
    expect(
      (await post("/proof", { token }, { cookie, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(
      (await post("/proof", { token }, { cookie, origin: STORE, "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    const form = await fetch(`${base}/v1/store/reviews`, {
      method: "POST",
      headers: { cookie, origin: STORE, "content-type": "application/x-www-form-urlencoded" },
      body: `token=${token}`,
    });
    expect(form.status).toBe(415);
    expect(await one("SELECT count(*)::int AS n FROM reviews")).toEqual({ n: 0 });
  });

  it("shows a link's products by ID and name only, with no-store and no referrer", async () => {
    const { token, productId, orderId, orderNumber } = await deliveredWithLink();
    const response = await post("/proof", { token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await response.text();
    const proof = storeReviewProofResponseSchema.parse(JSON.parse(text));
    expect(Object.keys(proof).sort()).toEqual(["expiresAt", "products"]);
    expect(proof.products).toEqual([{ productId, name: "Seed product" }]);
    // Nothing about the order or who placed it.
    for (const leak of [orderId, formatOrderNumber(orderNumber), "Seed Customer", "+971", "fils"])
      expect(text).not.toContain(leak);
  });

  it("gives one code for any link that proves nothing, an order ID included", async () => {
    const { orderId, productId, token } = await deliveredWithLink();
    const guesses = ["A".repeat(43), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")];
    for (const guess of guesses) {
      const read = await post("/proof", { token: guess });
      expect(read.status).toBe(409);
      expect(await errorCode(read)).toBe("REVIEW_PROOF_INVALID");
      const submitted = await post("", review(guess, productId));
      expect(await errorCode(submitted)).toBe("REVIEW_PROOF_INVALID");
    }
    // Not even shaped like a token: refused by the contract before the database.
    expect((await post("/proof", { token: orderId })).status).toBe(400);
    expect((await post("/proof", { orderId })).status).toBe(400);
    // A product the order does not contain.
    const other = await deliveredWithLink();
    expect(await errorCode(await post("", review(token, other.productId)))).toBe(
      "REVIEW_PROOF_INVALID",
    );
    // A replaced link stops working at once.
    await issueReviewLink(db, context(), orderId);
    expect(await errorCode(await post("/proof", { token }))).toBe("REVIEW_PROOF_INVALID");
    expect(await errorCode(await post("", review(token, productId)))).toBe("REVIEW_PROOF_INVALID");
    expect(await one("SELECT count(*)::int AS n FROM reviews")).toEqual({ n: 0 });
  });

  it("refuses ratings, text and fields outside the contract", async () => {
    const { token, productId } = await deliveredWithLink();
    for (const extra of [
      { rating: 0 },
      { rating: 6 },
      { rating: 4.5 },
      { rating: "5" },
      { title: "   " },
      { title: "x".repeat(121) },
      { title: "Bad\u0000title" },
      { title: "Zero​width" },
      { body: "Too short" },
      { body: "y".repeat(2001) },
      { body: "Bell \u0007 inside the text" },
      { authorName: "" },
      { authorName: "z".repeat(61) },
      { status: "approved" },
      { verified: true },
      { orderId: randomUUID() },
    ]) {
      const response = await post("", review(token, productId, extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await post("", "{not json")).status).toBe(400);
    expect(await one("SELECT count(*)::int AS n FROM reviews")).toEqual({ n: 0 });
  });

  it("stores a pending review once, with its audit entry and event, and publishes nothing", async () => {
    const { token, productId, orderId } = await deliveredWithLink();
    const response = await post("", review(token, productId));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(storeReviewResponseSchema.parse(await response.json())).toEqual({
      status: "pending",
      remaining: 0,
    });
    const row = await one<Record<string, unknown>>(
      `SELECT id, status, rating, title, body, author_name, order_id, moderated_by FROM reviews
       WHERE product_id=$1`,
      [productId],
    );
    expect(row).toMatchObject({
      status: "pending",
      rating: 4,
      title: "Solid kit",
      body: "Lasts all day.\n\nWould buy again.",
      author_name: "Sam R.",
      order_id: orderId,
      moderated_by: null,
    });
    const audit = await one<{ actor_type: string; diff: unknown }>(
      "SELECT actor_type, diff FROM audit_log WHERE entity_type='review' AND entity_id=$1",
      [row.id],
    );
    expect(audit.actor_type).toBe("system");
    const diffText = JSON.stringify(audit.diff);
    for (const words of ["Solid", "Lasts", "Sam"]) expect(diffText).not.toContain(words);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "review.submitted", aggregateId: row.id as string },
      include: { effects: true },
    });
    expect(event.payload).toEqual({ reviewId: row.id });
    expect(event.effects.map((effect) => effect.consumer)).toEqual(["notification"]);

    // The same product again, through the same link: refused, still one review.
    expect(await errorCode(await post("", review(token, productId)))).toBe("REVIEW_PROOF_INVALID");
    // Nothing is left to review, so the link no longer opens either.
    expect(await errorCode(await post("/proof", { token }))).toBe("REVIEW_PROOF_INVALID");
    expect(
      await one("SELECT count(*)::int AS n FROM reviews WHERE order_id=$1", [orderId]),
    ).toEqual({ n: 1 });
  });

  it("accepts exactly one of many parallel submissions for the same purchase", async () => {
    const { token, productId, orderId } = await deliveredWithLink();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        post("", review(token, productId, { rating: 1 + (n % 5) })),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409, 409, 409, 409, 409,
    ]);
    expect(
      await one("SELECT count(*)::int AS n FROM reviews WHERE order_id=$1", [orderId]),
    ).toEqual({ n: 1 });
  });

  it("limits submissions per address and counts refused ones too", async () => {
    const { token, productId } = await deliveredWithLink();
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let n = 0; n < 11; n += 1)
      statuses.push((await post("", review("B".repeat(43), productId), undefined, ip)).status);
    expect(statuses.slice(0, 10).every((status) => status === 409)).toBe(true);
    expect(statuses[10]).toBe(429);
    // The address is out of budget even with a good link; a review written later still works.
    expect((await post("", review(token, productId), undefined, ip)).status).toBe(429);
    expect((await post("", review(token, productId))).status).toBe(201);
  });

  it("tells moderators about a new review without the author's name or words", async () => {
    const { token, productId } = await deliveredWithLink();
    expect((await post("", review(token, productId))).status).toBe(201);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "review.submitted" },
      orderBy: { id: "desc" },
    });
    const write = () =>
      withTransaction(db, (tx) =>
        writeReviewNotification(tx, {
          eventId: event.id,
          reviewId: (event.payload as { reviewId: string }).reviewId,
        }),
      );
    const first = await write();
    const again = await write();
    expect(first).toMatchObject({ outcome: "written", created: true });
    expect(again).toMatchObject({ outcome: "written", created: false });
    const note = await one<{ title: string; body: string; link: string; type: string }>(
      "SELECT title, body, link, type FROM notifications WHERE source_event_id=$1",
      [event.id],
    );
    expect(note).toEqual({
      type: "review.submitted",
      title: "New review: Seed product",
      body: "4 of 5 stars · waiting for moderation",
      link: "/reviews",
    });
    // Receipts go to holders of reviews.moderate only (the Owners here).
    const receivers = await pool.query(
      `SELECT r.key FROM notification_receipts n JOIN staff_users s ON s.id=n.user_id
       JOIN roles r ON r.id=s.role_id WHERE n.notification_id=(
         SELECT id FROM notifications WHERE source_event_id=$1)`,
      [event.id],
    );
    expect(receivers.rows.length).toBeGreaterThan(0);
    expect(new Set(receivers.rows.map((row: { key: string }) => row.key))).toEqual(
      new Set(["owner"]),
    );
  });
});
