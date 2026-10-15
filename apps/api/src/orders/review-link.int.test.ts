import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { errorEnvelopeSchema, reviewLinkResponseSchema } from "@ih/contracts";
import {
  createDatabase,
  createPool,
  lockReviewProof,
  readReviewProof,
  ReviewProofInvalidError,
  withTransaction,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
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
  applicationName: "ih-review-link-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const DOMAIN = "shop.iqoshaven.test";
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
let ownerId = "";
let staffRoleId = "";
let host = 10;

const send = (path: string, method: string, cookie: string, origin = ADMIN) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    body: method === "GET" ? undefined : "{}",
  });
const issue = (orderId: string, cookie = staff, origin = ADMIN) =>
  send(`/${orderId}/review-link`, "POST", cookie, origin);
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const tokenOf = (link: string) => link.slice(link.indexOf("#") + 1);
const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest();
const productOf = async (orderId: string) =>
  (
    await one<{ id: string }>("SELECT product_id AS id FROM order_items WHERE order_id=$1", [
      orderId,
    ])
  ).id;

/** A seeded order taken through the real transition route to `targets`. */
async function orderAt(targets: string[]) {
  const seeded = await seedOrder(pool, { status: "confirmed" });
  for (const sql of [
    `UPDATE brands SET active=true WHERE id=(SELECT p.brand_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    `UPDATE categories SET active=true WHERE id=(SELECT p.category_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    "UPDATE products SET status='published' WHERE id=(SELECT product_id FROM variants WHERE id=$1)",
  ])
    await pool.query(sql, [seeded.variantId]);
  for (const to of targets) {
    const { version } = await one<{ version: number }>("SELECT version FROM orders WHERE id=$1", [
      seeded.orderId,
    ]);
    const response = await fetch(`${base}/v1/admin/orders/${seeded.orderId}/transitions`, {
      method: "POST",
      headers: {
        cookie: owner,
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
      },
      body: JSON.stringify({ to, expectedVersion: version, commandId: randomUUID() }),
    });
    expect(response.status).toBe(200);
  }
  return seeded;
}
const delivered = () => orderAt(["processing", "out_for_delivery", "delivered"]);
/** What a review submission (step 94) will do inside its transaction. */
const submit = (token: string, productId: string) =>
  withTransaction(db, async (tx) => {
    const proof = await lockReviewProof(tx, token, productId);
    await tx.$executeRawUnsafe(
      `INSERT INTO reviews (product_id, order_id, proof_id, rating, title, body, author_name)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 5, 'Good', 'Works well.', 'Customer')`,
      productId,
      proof.orderId,
      proof.proofId,
    );
    return proof;
  });

describe("verified-purchase review links through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: "Review " + key,
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
      return {
        id: user.id,
        roleId: role.id,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login("owner", "review-owner@iqoshaven.test");
    const s = await login("staff", "review-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
    await db.setting.createMany({
      data: [
        {
          key: "delivery",
          value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
          updatedBy: ownerId,
        },
        {
          key: "store",
          value: { name: "Iqos Haven", domain: DOMAIN, legalName: null },
          updatedBy: ownerId,
        },
      ],
    });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("creates a link only for a delivered order, with both rights, from the admin origin", async () => {
    const pending = await orderAt([]);
    expect((await issue(pending.orderId)).status).toBe(409);
    expect(await errorCode(await issue(pending.orderId))).toBe("REVIEW_NOT_ALLOWED");
    expect((await issue(randomUUID())).status).toBe(404);
    const done = await delivered();
    expect((await issue(done.orderId, staff, "https://elsewhere.example")).status).toBe(403);
    await pool.query(
      "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='customers.read'",
      [staffRoleId],
    );
    try {
      expect((await issue(done.orderId)).status).toBe(403);
    } finally {
      await pool.query(
        "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key='customers.read'",
        [staffRoleId],
      );
    }
    // Nothing was written by any refusal.
    expect(Number((await one<{ n: string }>("SELECT count(*) AS n FROM review_proofs")).n)).toBe(0);
  });

  it("shows the token once, stores only its hash, and reveals no order data", async () => {
    const done = await delivered();
    const response = await issue(done.orderId);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = reviewLinkResponseSchema.parse(await response.json());
    expect(body.link).toMatch(
      new RegExp(`^https://${DOMAIN.replaceAll(".", "\\.")}/review#[A-Za-z0-9_-]{43}$`),
    );
    expect(body.products).toBe(1);
    expect(body.whatsapp).toMatchObject({ placeholder: true });
    expect(body.whatsapp!.href).toMatch(/^https:\/\/wa\.me\/9715\d{8}\?text=/);
    expect(body.whatsapp!.text).toContain(body.link);
    const token = tokenOf(body.link);
    const stored = await one<{ token_hash: Buffer; expires_at: Date; issued_at: Date }>(
      "SELECT token_hash, expires_at, issued_at FROM review_proofs WHERE order_id=$1",
      [done.orderId],
    );
    expect(stored.token_hash.equals(hashOf(token))).toBe(true);
    expect(stored.expires_at.getTime() - stored.issued_at.getTime()).toBe(30 * 86_400_000);
    // The token is nowhere in the database, the audit log included.
    const dump = await one<{ text: string }>(
      "SELECT (SELECT string_agg(row_to_json(p)::text, '') FROM review_proofs p) || (SELECT string_agg(row_to_json(a)::text, '') FROM audit_log a) AS text",
    );
    expect(dump.text).not.toContain(token);
    expect(
      (
        await one<{ n: string }>(
          "SELECT count(*) AS n FROM audit_log WHERE entity_id=$1 AND action='order.review_link_issued'",
          [done.orderId],
        )
      ).n,
    ).toBe("1");
    // What the link reads as: products only.
    const proof = await readReviewProof(db, token);
    expect(proof).toEqual({
      expiresAt: stored.expires_at.toISOString(),
      products: [{ productId: await productOf(done.orderId), name: "Seed product" }],
    });
    expect(JSON.stringify(proof)).not.toMatch(/order|phone|Seed Customer|IH-/i);
  });

  it("refuses an order ID, a guessed or replaced token, an expired one, and other orders' products", async () => {
    const done = await delivered();
    const other = await delivered();
    const product = await productOf(done.orderId);
    const first = tokenOf(
      reviewLinkResponseSchema.parse(await (await issue(done.orderId)).json()).link,
    );
    const second = tokenOf(
      reviewLinkResponseSchema.parse(await (await issue(done.orderId)).json()).link,
    );
    const refused = (token: string, productId = product) =>
      expect(submit(token, productId)).rejects.toBeInstanceOf(ReviewProofInvalidError);
    // An order ID is not a proof, nor is a well-formed guess.
    await refused(done.orderId);
    await refused(randomBytes(32).toString("base64url"));
    // A newer link replaces the older one.
    await refused(first);
    expect(await readReviewProof(db, first)).toBeNull();
    // A live proof covers its own order's products only.
    await refused(second, await productOf(other.orderId));
    // An expired proof proves nothing.
    const expired = randomBytes(32).toString("base64url");
    await pool.query(
      "UPDATE review_proofs SET revoked_at=statement_timestamp() WHERE order_id=$1",
      [other.orderId],
    );
    await pool.query(
      `INSERT INTO review_proofs (order_id, token_hash, issued_by, issued_at, expires_at)
       VALUES ($1, $2, $3, now() - interval '31 days', now() - interval '1 day')`,
      [other.orderId, hashOf(expired), ownerId],
    );
    await refused(expired, await productOf(other.orderId));
    expect(await readReviewProof(db, expired)).toBeNull();
    // The live one works, once per product.
    await expect(submit(second, product)).resolves.toMatchObject({ orderId: done.orderId });
    await refused(second);
    expect(await readReviewProof(db, second)).toBeNull();
    expect(await errorCode(await issue(done.orderId))).toBe("NOTHING_TO_REVIEW");
  });

  it("lets two submissions with one link record one review", async () => {
    const done = await delivered();
    const token = tokenOf(
      reviewLinkResponseSchema.parse(await (await issue(done.orderId)).json()).link,
    );
    const product = await productOf(done.orderId);
    const results = await Promise.allSettled([submit(token, product), submit(token, product)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      Number(
        (
          await one<{ n: string }>("SELECT count(*) AS n FROM reviews WHERE order_id=$1", [
            done.orderId,
          ])
        ).n,
      ),
    ).toBe(1);
  });

  it("keeps reviews and proofs as the database allows them", async () => {
    const done = await delivered();
    const other = await delivered();
    const token = tokenOf(
      reviewLinkResponseSchema.parse(await (await issue(done.orderId)).json()).link,
    );
    const proof = await submit(token, await productOf(done.orderId));
    const refused = (sql: string, params: unknown[]) =>
      expect(pool.query(sql, params)).rejects.toThrow();
    // A product the order does not contain, or a review that starts approved.
    await refused(
      `INSERT INTO reviews (product_id, order_id, proof_id, rating, title, body, author_name)
       VALUES ($1, $2, $3, 4, 'T', 'B', 'A')`,
      [await productOf(other.orderId), done.orderId, proof.proofId],
    );
    await refused(
      `INSERT INTO reviews (product_id, order_id, proof_id, rating, title, body, author_name, status, moderated_by, moderated_at)
       VALUES ($1, $2, $3, 4, 'T', 'B', 'A', 'approved', $4, now())`,
      [await productOf(other.orderId), other.orderId, proof.proofId, ownerId],
    );
    // Content never changes; nothing is deleted; a proof changes only by being revoked.
    await refused("UPDATE reviews SET body='Changed', version=version+1 WHERE order_id=$1", [
      done.orderId,
    ]);
    await refused("DELETE FROM reviews WHERE order_id=$1", [done.orderId]);
    await refused(
      "UPDATE review_proofs SET expires_at=expires_at + interval '1 day' WHERE order_id=$1",
      [done.orderId],
    );
    await refused("DELETE FROM review_proofs WHERE order_id=$1", [done.orderId]);
    // Moderation is the one allowed change (step 95).
    await pool.query(
      "UPDATE reviews SET status='approved', moderated_by=$2, moderated_at=now(), version=version+1 WHERE order_id=$1",
      [done.orderId, ownerId],
    );
  });

  it("needs the store's domain for a link", async () => {
    const done = await delivered();
    await pool.query("DELETE FROM settings WHERE key='store'");
    try {
      expect(await errorCode(await issue(done.orderId))).toBe("STORE_DOMAIN_REQUIRED");
    } finally {
      await db.setting.create({
        data: {
          key: "store",
          value: { name: "Iqos Haven", domain: DOMAIN, legalName: null },
          updatedBy: ownerId,
        },
      });
    }
  });
});
