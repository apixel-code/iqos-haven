import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  AGE_VERIFICATION_REQUIRED,
  storeQuoteResponseSchema,
  type StoreQuoteResponse,
} from "@ih/contracts";
import {
  createDatabase,
  createPool,
  lockCouponForOrder,
  lockQuoteForOrder,
  redeemCoupon,
  withTransaction,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import {
  AGE_COOKIE,
  ageTicketPublicKey,
  ageTicketSigner,
  checkAcceptedQuote,
  signAgeTicket,
  verifyQuote,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CartQuoteService, quoteFacts } from "./cart-quote.service";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-cart-quote-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "quote-test-1";
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
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
  STOREFRONT_ORIGINS: STORE,
});
const cookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base: string;
let quotes: CartQuoteService;
let staffId = "";
let areaId = "";
let closedAreaId = "";
let ip = 10;
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
/** A fresh client address per call keeps the per-address limiter out of unrelated tests. */
const post = (
  body: unknown,
  headers: Record<string, string> = { cookie, origin: STORE },
  address = `198.51.100.${(ip = (ip % 250) + 1)}`,
) =>
  fetch(`${base}/v1/store/cart/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ih-client-ip": address, ...headers },
    body: JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
async function variant(
  basePriceFils: bigint,
  options: { stock?: number; name?: string; draft?: boolean } = {},
) {
  const brand = await db.brand.create({
    data: { name: "Synthetic brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Synthetic category " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: options.name ?? "Synthetic product",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils,
      status: options.draft ? "draft" : "published",
    },
  });
  const row = await db.variant.create({
    data: { productId: product.id, sku: key().toUpperCase(), active: true, isDefault: true },
  });
  if (options.stock)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [row.id, options.stock, randomUUID()],
    );
  return { id: row.id, productId: product.id };
}
const coupon = (code: string, extra: { active?: boolean; usageLimit?: number } = {}) =>
  db.coupon.create({
    data: { code, percentBps: 1500, active: true, updatedBy: staffId, ...extra },
  });

describe("cart quote through the real API (PostgreSQL, Ed25519 ticket)", () => {
  let kit: Awaited<ReturnType<typeof variant>>;
  let pods: Awaited<ReturnType<typeof variant>>;
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "quote@iqoshaven.test",
          name: "Seeder",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    const area = (code: string, active: boolean) =>
      db.deliveryArea.create({
        data: { code, name: "Synthetic " + code, emirate: "sharjah", active, updatedBy: staffId },
      });
    areaId = (await area("synthetic_open", true)).id;
    closedAreaId = (await area("synthetic_closed", false)).id;
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: staffId,
        value: { flatFeeFils: 1500, etaText: "Synthetic ETA", freeThresholdFils: null },
      },
    });
    kit = await variant(12999n, { stock: 5, name: "Quote Probe Kit" });
    pods = await variant(4500n, { stock: 1 });
    await coupon("QUOTE15");
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    quotes = app.get(CartQuoteService);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  const cart = () => ({
    lines: [
      { variantId: pods.id, quantity: 2 },
      { variantId: kit.id, quantity: 1 },
    ],
    areaId,
    couponCode: "quote15",
  });

  it("answers nothing without a valid age ticket or from another origin", async () => {
    for (const headers of [
      { origin: STORE },
      { origin: STORE, cookie: `${AGE_COOKIE}=accepted` },
      { origin: STORE, cookie: cookie.slice(0, -4) + "AAAA" },
      { origin: STORE, "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    ] as Array<Record<string, string>>) {
      const response = await post(cart(), headers);
      const text = await response.text();
      expect(response.status).toBe(403);
      expect(JSON.parse(text).error.code).toBe(AGE_VERIFICATION_REQUIRED);
      for (const secret of ["12999", "Synthetic ETA", "QUOTE15", kit.id])
        expect(text).not.toContain(secret);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    // A verified shopper's browser is still refused when another site makes the request.
    for (const headers of [
      { cookie },
      { cookie, origin: "https://attacker.example" },
      { cookie, origin: STORE, "sec-fetch-site": "cross-site" },
    ] as Array<Record<string, string>>)
      expect((await post(cart(), headers)).status).toBe(403);
  });
  it("returns the authoritative total with a signed, short-lived token", async () => {
    const started = Date.now();
    const response = await post(cart());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toMatch(/cookie/i);
    const text = await response.text();
    const quote = storeQuoteResponseSchema.parse(JSON.parse(text));
    // 12999 + 2 × 4500 = 21999; 15 % = 3299.85 → 3300; + 1500 delivery.
    expect(quote).toMatchObject({
      merchandiseSubtotalFils: 21999,
      discountFils: 3300,
      deliveryFeeFils: 1500,
      totalFils: 20199,
      freeDeliveryThresholdFils: null,
      delivery: {
        areaId,
        areaName: "Synthetic synthetic_open",
        emirate: "sharjah",
        etaText: "Synthetic ETA",
      },
      coupon: { code: "QUOTE15", percentBps: 1500 },
      // Two pods were asked for and one is in stock: named, not counted.
      insufficientStock: [pods.id],
    });
    expect(quote.lines.map((line) => line.totalFils).reduce((a, b) => a + b, 0)).toBe(18699);
    // No stock number, version, internal reference or staff field.
    for (const hidden of ["Version", "productId", "couponId", "areaCode", "stock_on_hand", "sku"])
      expect(text).not.toContain(hidden);
    // The token is the server's, over exactly these facts, for about fifteen minutes.
    const verified = verifyQuote(quote.quote.token, quotes.keys, new Date());
    expect(verified).toMatchObject({ ok: true, fingerprint: quote.quote.fingerprint });
    const life = Date.parse(quote.quote.expiresAt) - started;
    expect(life).toBeGreaterThan(898_000);
    expect(life).toBeLessThanOrEqual(901_000);
    expect(
      verifyQuote(quote.quote.token, quotes.keys, new Date(Date.parse(quote.quote.expiresAt))),
    ).toEqual({ ok: false, reason: "expired" });
    // Asking again for the same cart gives the same fingerprint.
    const again = (await (await post(cart())).json()) as StoreQuoteResponse;
    expect(again.quote.fingerprint).toBe(quote.quote.fingerprint);
    // A quote reserves and records nothing.
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "QUOTE15" } })).activeRedemptions,
    ).toBe(0);
    expect(await db.stockMovement.count({ where: { delta: { lt: 0 } } })).toBe(0);
  });
  it("lets the order accept only the total that was shown", async () => {
    const product = await variant(8000n, { stock: 5 });
    const input = { lines: [{ variantId: product.id, quantity: 2 }], areaId, couponCode: null };
    const shown = (await (await post(input)).json()) as StoreQuoteResponse;
    const decide = () =>
      withTransaction(db, async (tx) =>
        checkAcceptedQuote(
          shown.quote.token,
          quotes.keys,
          new Date(),
          quoteFacts(await lockQuoteForOrder(tx, input)),
        ),
      );
    expect(await decide()).toBe("ACCEPTED");
    // A description edit bumps the version but not the charge: still the accepted total.
    await pool.query(
      "UPDATE products SET description='Edited copy', version=version+1 WHERE id=$1",
      [product.productId],
    );
    expect(await decide()).toBe("ACCEPTED");
    // A price that went down is still a change: nothing is charged that was not shown.
    await pool.query("UPDATE products SET base_price_fils=7999, version=version+1 WHERE id=$1", [
      product.productId,
    ]);
    expect(await decide()).toBe("QUOTE_CHANGED");
    await pool.query("UPDATE products SET base_price_fils=8000, version=version+1 WHERE id=$1", [
      product.productId,
    ]);
    expect(await decide()).toBe("ACCEPTED");
    await pool.query(
      `UPDATE settings SET value=jsonb_set(value,'{flatFeeFils}','2000'), version=version+1 WHERE key='delivery'`,
    );
    expect(await decide()).toBe("QUOTE_CHANGED");
    const fresh = (await (await post(input)).json()) as StoreQuoteResponse;
    expect(fresh).toMatchObject({ deliveryFeeFils: 2000, totalFils: 18000 });
    expect(fresh.quote.fingerprint).not.toBe(shown.quote.fingerprint);
    await pool.query(
      `UPDATE settings SET value=jsonb_set(value,'{flatFeeFils}','1500'), version=version+1 WHERE key='delivery'`,
    );
  });
  it("refuses any body that is not lines, an area and one code", async () => {
    const good = cart();
    for (const bad of [
      { ...good, totalFils: 1 },
      { ...good, deliveryFeeFils: 0 },
      { ...good, discountFils: 99999 },
      { ...good, lines: [{ variantId: kit.id, quantity: 1, unitPriceFils: 1 }] },
      { ...good, lines: [{ variantId: kit.id, quantity: 1, priceFils: 1 }] },
      { ...good, lines: [] },
      { ...good, lines: [{ variantId: kit.id, quantity: 11 }] },
      { ...good, lines: [{ variantId: kit.id, quantity: 0 }] },
      { ...good, lines: [{ variantId: kit.id, quantity: 1.5 }] },
      { ...good, lines: [{ variantId: kit.id, quantity: "2" }] },
      {
        ...good,
        lines: [
          { variantId: kit.id, quantity: 6 },
          { variantId: kit.id, quantity: 5 },
        ],
      },
      {
        ...good,
        lines: Array.from({ length: 51 }, () => ({ variantId: randomUUID(), quantity: 1 })),
      },
      { ...good, lines: [{ variantId: "nope", quantity: 1 }] },
      { ...good, areaId: "nope" },
      { ...good, couponCode: ["QUOTE15", "OTHER10"] },
      { ...good, couponCode: "two codes" },
      { ...good, couponCodes: ["QUOTE15"] },
      { lines: good.lines },
      [],
      "cart",
    ])
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 90)).toBe(400);
    // No code, null and blank all mean "no coupon".
    for (const couponCode of [undefined, null, " "])
      expect(
        (await (await post({ ...good, couponCode })).json()) as StoreQuoteResponse,
      ).toMatchObject({
        discountFils: 0,
        coupon: null,
      });
  });
  it("answers one stable code when the cart cannot be priced", async () => {
    const good = cart();
    const draft = await variant(5000n, { draft: true, name: "Hidden Draft Probe" });
    await coupon("QUOTEOFF", { active: false });
    await coupon("QUOTEFULL", { usageLimit: 1 });
    const { orderId } = await seedOrder(pool);
    await withTransaction(db, async (tx) => {
      await redeemCoupon(tx, orderId, await lockCouponForOrder(tx, "QUOTEFULL", 5000));
    });
    for (const [body, code] of [
      [{ ...good, areaId: closedAreaId }, "AREA_UNAVAILABLE"],
      [{ ...good, areaId: randomUUID() }, "AREA_UNAVAILABLE"],
      [
        { ...good, lines: [...good.lines, { variantId: draft.id, quantity: 1 }] },
        "VARIANT_UNAVAILABLE",
      ],
      [{ ...good, lines: [{ variantId: randomUUID(), quantity: 1 }] }, "VARIANT_UNAVAILABLE"],
      [{ ...good, couponCode: "NOSUCHCODE" }, "COUPON_INVALID"],
      // An inactive code is indistinguishable from one that does not exist.
      [{ ...good, couponCode: "QUOTEOFF" }, "COUPON_INVALID"],
      [{ ...good, couponCode: "QUOTEFULL" }, "COUPON_LIMIT_REACHED"],
    ] as const) {
      const response = await post(body);
      const text = await response.text();
      expect(response.status, code).toBe(409);
      expect(JSON.parse(text).error.code).toBe(code);
      for (const leak of ["Hidden Draft Probe", draft.id, "INACTIVE", "UNKNOWN", "12999"])
        expect(text).not.toContain(leak);
    }
    // A closed area and a hidden line are reported before the coupon is even looked at.
    expect(
      await errorCode(await post({ ...good, areaId: closedAreaId, couponCode: "NOSUCHCODE" })),
    ).toBe("AREA_UNAVAILABLE");
  });
  it("limits quotes per client address so codes cannot be guessed quickly", async () => {
    const address = "203.0.113.77";
    const statuses: number[] = [];
    for (let n = 0; n < 33; n++)
      statuses.push(
        (await post({ ...cart(), couponCode: "GUESS" + n }, { cookie, origin: STORE }, address))
          .status,
      );
    expect(statuses.slice(0, 30).every((status) => status === 409)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429, 429]);
  });
});
