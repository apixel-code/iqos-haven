import "reflect-metadata";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
  errorEnvelopeSchema,
  ORDER_LIMITS,
  storeOrderResponseSchema,
  orderConfirmationResponseSchema,
} from "@ih/contracts";
import {
  createDatabase,
  createPool,
  deleteExpiredIdempotencyRecords,
  clearExpiredConfirmationReplay,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import {
  ORDER_COOKIE,
  confirmationHash,
  AGE_COOKIE,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
  signQuote,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CartQuoteService } from "../store/cart-quote.service";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-store-orders-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "order-route-test-1";
const STORE = "http://localhost:8080";
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
const disabledEnv = apiEnvSchema.parse({
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
  // One ring for every app below, so a total shown by one can be accepted by another.
  ORDER_CONFIRMATION_KEYS: `confirmation:c1:${randomBytes(32).toString("base64url")}`,
  QUOTE_SIGNING_KEYS: `quote:t1:${randomBytes(32).toString("base64url")}`,
});
const env = { ...disabledEnv, CHECKOUT_SUBMISSION_ENABLED: true };
const cookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base: string;
let quotes: CartQuoteService;
let staffId = "";
let areaId = "";
let closedAreaId = "";
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
const attemptKey = () => randomBytes(24).toString("base64url");
let serial = 0;
const phone = () => "050 620 " + String(++serial).padStart(4, "0");
let host = 0;
/** A fresh client address per call keeps the per-address limiters out of unrelated tests. */
const address = () => `198.51.${100 + Math.floor(host / 250)}.${(host++ % 250) + 1}`;

async function variant(basePriceFils: bigint, stock = 0) {
  const brand = await db.brand.create({
    data: { name: "Synthetic brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Synthetic category " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: "Synthetic product",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils,
      status: "published",
    },
  });
  const row = await db.variant.create({
    data: { productId: product.id, sku: key().toUpperCase(), active: true, isDefault: true },
  });
  if (stock)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [row.id, stock, randomUUID()],
    );
  return { id: row.id, productId: product.id };
}
interface Cart {
  lines: Array<{ variantId: string; quantity: number }>;
  couponCode?: string | null;
  areaId?: string;
}
/** What the checkout form sends, as typed: a total is fetched first and its token sent back. */
async function order(cart: Cart, changes: Record<string, unknown> = {}) {
  const shown = await quotes.quote({
    lines: cart.lines,
    areaId: cart.areaId ?? areaId,
    couponCode: cart.couponCode ?? null,
  });
  return {
    contact: { name: "  Synthetic   Buyer ", phone: phone() },
    address: {
      areaId: cart.areaId ?? areaId,
      type: "apartment",
      building: "Synthetic Tower",
      unit: "1204",
    },
    lines: cart.lines,
    couponCode: cart.couponCode ?? null,
    quoteToken: shown.quote.token,
    ageConfirmed: true,
    ...changes,
  };
}
interface Sent {
  key?: string | null;
  ip?: string;
  headers?: Record<string, string>;
  to?: string;
}
const post = (body: unknown, sent: Sent = {}, path = "/v1/store/orders") =>
  fetch((sent.to ?? base) + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ih-client-ip": sent.ip ?? address(),
      ...(sent.key === null ? {} : { "idempotency-key": sent.key ?? attemptKey() }),
      ...(sent.headers ?? { cookie, origin: STORE }),
    },
    body: JSON.stringify(body),
  });
const quote = (body: unknown, ip: string) => post(body, { ip, key: null }, "/v1/store/cart/quote");
const envelope = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error;
const refusal = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await envelope(response)).code).toBe(code);
};
const stockOf = async (variantId: string) =>
  (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand;
/** Everything an order writes, counted, to show that a refused request wrote none of it. */
const footprint = async () => ({
  orders: await db.order.count(),
  sales: await db.stockMovement.count({ where: { reason: "SALE" } }),
  redemptions: await db.couponRedemption.count(),
  customers: await db.customer.count(),
  idempotency: await db.idempotencyRecord.count(),
  events: (await pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n as number,
});

describe("POST /v1/store/orders through the real API (PostgreSQL, Ed25519 ticket)", () => {
  let item: Awaited<ReturnType<typeof variant>>;
  let cart: Cart;
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "store-orders@iqoshaven.test",
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
    await db.coupon.create({
      data: { code: "ROUTE10", percentBps: 1000, active: true, updatedBy: staffId },
    });
    item = await variant(8000n, 500);
    cart = { lines: [{ variantId: item.id, quantity: 1 }] };
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

  it("places one order and answers with the order number, total and time only", async () => {
    const before = await footprint();
    const body = await order({
      lines: [{ variantId: item.id, quantity: 2 }],
      couponCode: "route10",
    });
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain("__Host-ih_order=");
    const placed = storeOrderResponseSchema.parse(await response.json());
    // 2 × 80.00 less 10 % plus 15.00 delivery, in fils.
    expect(placed.totalFils).toBe(15900);
    expect(placed.orderNumber).toMatch(/^IH-\d{6,}$/);
    const after = await footprint();
    expect(after).toEqual({
      orders: before.orders + 1,
      sales: before.sales + 1,
      redemptions: before.redemptions + 1,
      customers: before.customers + 1,
      idempotency: before.idempotency + 1,
      events: before.events + 1,
    });
    const stored = await db.order.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(stored).toMatchObject({
      status: "pending",
      source: "storefront",
      customerName: "Synthetic Buyer",
      agePolicyVersion: POLICY,
      couponCode: "ROUTE10",
    });
    expect(Number(stored.totalFils)).toBe(15900);
    // The inbox notification and the shop email are required work of this order (step 78),
    // written with it and waiting for the worker.
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: stored.id, eventType: "order.created" },
      include: { effects: true },
    });
    expect(event.completedAt).toBeNull();
    expect(event.effects.map((effect) => [effect.consumer, effect.status]).sort()).toEqual([
      ["analytics_rollup", "pending"],
      ["email", "pending"],
      ["notification", "pending"],
    ]);
  });

  it("refuses everything while submission is switched off, and writes nothing", async () => {
    const off = await createApp(disabledEnv, { pool, database: db });
    await off.listen(0, "127.0.0.1");
    try {
      const before = await footprint();
      const stock = await stockOf(item.id);
      const response = await post(await order(cart), { to: await off.getUrl() });
      await refusal(response, 503, "SERVICE_UNAVAILABLE");
      expect(await footprint()).toEqual(before);
      expect(await stockOf(item.id)).toBe(stock);
    } finally {
      await off.close();
    }
  });

  it("requires the age ticket and the store Origin", async () => {
    const before = await footprint();
    const body = await order(cart);
    const unverified = await post(body, { headers: { origin: STORE } });
    await refusal(unverified, 403, AGE_VERIFICATION_REQUIRED);
    // A crawler's user agent is no ticket.
    const crawler = await post(body, {
      headers: { origin: STORE, "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    });
    await refusal(crawler, 403, AGE_VERIFICATION_REQUIRED);
    expect((await post(body, { headers: { cookie } })).status).toBe(403);
    expect((await post(body, { headers: { cookie, origin: "https://evil.example" } })).status).toBe(
      403,
    );
    expect(
      (await post(body, { headers: { cookie, origin: STORE, "sec-fetch-site": "cross-site" } }))
        .status,
    ).toBe(403);
    expect(await footprint()).toEqual(before);
  });

  it("rejects an invalid request without echoing what was typed", async () => {
    const before = await footprint();
    const good = await order(cart);
    const invalid = async (body: unknown, paths: string[], sent: Sent = {}) => {
      const response = await post(body, sent);
      expect(response.status).toBe(400);
      const text = await response.text();
      const error = errorEnvelopeSchema.parse(JSON.parse(text)).error;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.fields.map((field) => field.path).sort()).toEqual(paths);
      expect(error.fields.every((field) => field.message === "Invalid field")).toBe(true);
      return text;
    };
    const typed = await invalid(
      {
        ...good,
        contact: { name: "Q", phone: "0441234999" },
        address: { ...good.address, unit: "" },
      },
      ["address.unit", "contact.name", "contact.phone"],
    );
    expect(typed).not.toContain("0441234999");
    // The second 18+ confirmation is required, and only `true` is one.
    await invalid({ ...good, ageConfirmed: false }, ["ageConfirmed"]);
    const { ageConfirmed: _omitted, ...unconfirmed } = good;
    await invalid(unconfirmed, ["ageConfirmed"]);
    // No client price, fee or total is accepted, under any name.
    await invalid({ ...good, totalFils: 1 }, [""]);
    await invalid({ ...good, lines: [{ ...good.lines[0], unitPriceFils: 1 }] }, ["lines.0"]);
    await invalid({ ...good, lines: [] }, ["lines"]);
    await invalid({ ...good, quoteToken: "" }, ["quoteToken"]);
    // The attempt key is required and must look random enough.
    await invalid(good, ["idempotencyKey"], { key: null });
    await invalid(good, ["idempotencyKey"], { key: "short" });
    await invalid(good, ["idempotencyKey"], { key: "has spaces in it, which no key has" });
    expect(await footprint()).toEqual(before);
  });

  it("answers a retry with the same order and refuses a changed request", async () => {
    const body = await order(cart);
    const sent = { key: attemptKey() };
    const first = await post(body, sent);
    expect(first.status).toBe(201);
    const placed = await first.json();
    const before = await footprint();
    const stock = await stockOf(item.id);
    // The same request again, from another address and spelled differently.
    const retry = await post(
      {
        ...body,
        contact: { name: "Synthetic Buyer", phone: body.contact.phone.replaceAll(" ", "") },
      },
      sent,
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(placed);
    // Two at once with a new key: one order, the same answer for both.
    const again = await order(cart);
    const pair = { key: attemptKey() };
    const both = await Promise.all([post(again, pair), post(again, pair)]);
    const answers = await Promise.all(both.map(async (r) => [r.status, await r.json()] as const));
    const ok = answers.filter(([status]) => status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const [status, answer] of answers) {
      if (status === 201) expect(answer).toEqual(ok[0]![1]);
      // The loser may be told to retry; it is never told anything else.
      else
        expect([status, answer]).toMatchObject([
          409,
          { error: { code: "IDEMPOTENCY_IN_PROGRESS" } },
        ]);
    }
    expect((await footprint()).orders).toBe(before.orders + 1);
    expect(await stockOf(item.id)).toBe(stock - 1);
    // The same key with another quantity is a different request.
    const changed = await post({ ...body, lines: [{ variantId: item.id, quantity: 3 }] }, sent);
    await refusal(changed, 409, "IDEMPOTENCY_CONFLICT");
    expect((await footprint()).orders).toBe(before.orders + 1);
  });

  it("never treats a key as new after its answer is cleaned up", async () => {
    const body = await order(cart);
    const sent = { key: attemptKey() };
    const placed = storeOrderResponseSchema.parse(await (await post(body, sent)).json());
    const stored = await db.order.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    // What the hourly cleanup does once the answer is more than a day old.
    await pool.query(
      "ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_records_guard; ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_cookie_guard",
    );
    await pool.query(
      "UPDATE idempotency_records SET created_at=created_at-interval '2 days', expires_at=expires_at-interval '2 days', replay_cookie_expires_at=replay_cookie_expires_at-interval '2 days' WHERE resource_id=$1",
      [stored.id],
    );
    await pool.query(
      "ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_records_guard; ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_cookie_guard",
    );
    await refusal(await post(body, sent), 409, "CHECKOUT_RECOVERY_REQUIRED");
    expect(await deleteExpiredIdempotencyRecords(db)).toBeGreaterThanOrEqual(1);
    const before = await footprint();
    const response = await post(body, sent);
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("CHECKOUT_RECOVERY_REQUIRED");
    // It does not say which order: the key alone must not reveal it.
    expect(text).not.toContain(stored.id);
    expect(text).not.toContain(placed.orderNumber);
    expect(await footprint()).toEqual(before);
  });

  it("maps each refusal to one stable code and writes nothing", async () => {
    const before = await footprint();
    const stock = await stockOf(item.id);
    // The price moved after the total was shown.
    const moving = await variant(8000n, 5);
    const stale = await order({ lines: [{ variantId: moving.id, quantity: 1 }] });
    await pool.query("UPDATE products SET base_price_fils=8100, version=version+1 WHERE id=$1", [
      moving.productId,
    ]);
    await refusal(await post(stale), 409, "QUOTE_CHANGED");
    // A total accepted too long ago, and a token this server never issued.
    const fresh = await order(cart);
    const fingerprint = fresh.quoteToken.split(".")[3]!;
    const expired = signQuote(fingerprint, new Date(Date.now() - 1000), quotes.keys[0]!);
    await refusal(await post({ ...fresh, quoteToken: expired }), 409, "QUOTE_EXPIRED");
    await refusal(await post({ ...fresh, quoteToken: "not.a.token" }), 409, "QUOTE_CHANGED");
    // More than is in stock.
    const scarce = await variant(5000n, 1);
    const greedy = await order({ lines: [{ variantId: scarce.id, quantity: 2 }] });
    const short = await post(greedy);
    expect(short.status).toBe(409);
    const shortText = await short.text();
    expect(JSON.parse(shortText).error.code).toBe("INSUFFICIENT_STOCK");
    expect(shortText).not.toContain(scarce.id);
    expect(await stockOf(scarce.id)).toBe(1);
    // A variant withdrawn after the total was shown.
    const withdrawn = await variant(5000n, 3);
    const gone = await order({ lines: [{ variantId: withdrawn.id, quantity: 1 }] });
    await pool.query("UPDATE products SET status='draft', version=version+1 WHERE id=$1", [
      withdrawn.productId,
    ]);
    await refusal(await post(gone), 409, "VARIANT_UNAVAILABLE");
    // An area that is not served, and a code that does not exist.
    const elsewhere = { ...fresh, address: { ...fresh.address, areaId: closedAreaId } };
    await refusal(await post(elsewhere), 409, "AREA_UNAVAILABLE");
    await refusal(await post({ ...fresh, couponCode: "NOSUCHCODE" }), 409, "COUPON_INVALID");
    expect(await footprint()).toEqual(before);
    expect(await stockOf(item.id)).toBe(stock);
  });

  it("limits attempts per phone and per address, counting refused ones", async () => {
    const before = await footprint();
    const body = await order(cart, { quoteToken: "not.a.token" });
    // Five a minute for one phone, from any address.
    for (let i = 0; i < 5; i++) await refusal(await post(body), 409, "QUOTE_CHANGED");
    const sixth = await post(body);
    await refusal(sixth, 429, "RATE_LIMITED");
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    // Ten a minute for one address, whatever the phone.
    const ip = address();
    for (let i = 0; i < 10; i++)
      await refusal(
        await post({ ...body, contact: { name: "Buyer", phone: phone() } }, { ip }),
        409,
        "QUOTE_CHANGED",
      );
    const other = { ...body, contact: { name: "Buyer", phone: phone() } };
    await refusal(await post(other, { ip }), 429, "RATE_LIMITED");
    // A real order from that address is refused too, and nothing is written.
    const real = await order(cart);
    await refusal(await post(real, { ip }), 429, "RATE_LIMITED");
    expect(await footprint()).toEqual(before);
    // Quotes have their own budget: the same address can still price a cart.
    expect((await quote({ lines: cart.lines, areaId, couponCode: null }, ip)).status).toBe(200);
  });

  it("stops code guessing across the quote and the order route", async () => {
    const ip = address();
    const priced = { lines: cart.lines, areaId };
    const wrong = () => "GUESS" + randomBytes(4).toString("hex").toUpperCase();
    // Four wrong codes at checkout and six on the cart: ten in all.
    const body = await order(cart);
    for (let i = 0; i < 4; i++)
      await refusal(
        await post(
          { ...body, couponCode: wrong(), contact: { name: "Buyer", phone: phone() } },
          { ip },
        ),
        409,
        "COUPON_INVALID",
      );
    // A good code in between is answered and uses none of the budget.
    for (let i = 0; i < 3; i++)
      expect((await quote({ ...priced, couponCode: "ROUTE10" }, ip)).status).toBe(200);
    for (let i = 0; i < 6; i++)
      await refusal(await quote({ ...priced, couponCode: wrong() }, ip), 409, "COUPON_INVALID");
    // From now on a code is not looked at, right or wrong, on either route.
    await refusal(await quote({ ...priced, couponCode: wrong() }, ip), 429, "RATE_LIMITED");
    const right = await quote({ ...priced, couponCode: "ROUTE10" }, ip);
    await refusal(right, 429, "RATE_LIMITED");
    expect(Number(right.headers.get("retry-after"))).toBeGreaterThan(60);
    const before = await footprint();
    const withCode = await order({ ...cart, couponCode: "ROUTE10" });
    await refusal(await post(withCode, { ip }), 429, "RATE_LIMITED");
    expect(await footprint()).toEqual(before);
    // Shopping without a code goes on, and so does everyone else.
    expect((await quote({ ...priced, couponCode: null }, ip)).status).toBe(200);
    expect((await post(await order(cart), { ip })).status).toBe(201);
    expect((await quote({ ...priced, couponCode: "ROUTE10" }, address())).status).toBe(200);
  });

  it("keeps taking orders within local limits when the shared limiter is down", async () => {
    const degraded = await createApp(
      {
        ...env,
        RATE_LIMIT_PROFILE: "replicated",
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
      { pool, database: db },
    );
    await degraded.listen(0, "127.0.0.1");
    try {
      const to = await degraded.getUrl();
      const before = await footprint();
      const body = await order({ ...cart, couponCode: "ROUTE10" });
      const sent = { key: attemptKey(), to };
      // A legitimate order goes through, and so does its retry.
      const first = await post(body, sent);
      expect(first.status).toBe(201);
      const retry = await post(body, sent);
      expect(retry.status).toBe(201);
      expect(await retry.json()).toEqual(await first.json());
      // The outage budget for one phone is two a minute, not unlimited.
      const third = await post(body, sent);
      await refusal(third, 429, "RATE_LIMITED");
      expect((await footprint()).orders).toBe(before.orders + 1);
      // Code guessing stays bounded as well: five wrong codes, then no code is looked at.
      const ip = address();
      const priced = { lines: cart.lines, areaId };
      const guess = (couponCode: string) =>
        post({ ...priced, couponCode }, { ip, key: null, to }, "/v1/store/cart/quote");
      for (let i = 0; i < 5; i++) await refusal(await guess("WRONG" + i), 409, "COUPON_INVALID");
      await refusal(await guess("ROUTE10"), 429, "RATE_LIMITED");
    } finally {
      await degraded.close();
    }
  });
  const confirmation = (cookieValue: string | undefined, query = "", ip = address()) =>
    fetch(base + "/v1/store/order-confirmation" + query, {
      headers: { "x-ih-client-ip": ip, ...(cookieValue ? { cookie: cookieValue } : {}) },
    });
  it("returns only cookie-authorized snapshots and never needs an age or admin credential", async () => {
    const body = await order(cart),
      sent = { key: attemptKey() };
    const first = await post(body, sent);
    const placed = storeOrderResponseSchema.parse(await first.json());
    const set = first.headers.get("set-cookie")!;
    expect(set).toMatch(/Max-Age=(17[0-9]{2}|1800); Path=\/; Secure; HttpOnly; SameSite=Lax/);
    const cap = set.split(";", 1)[0]!;
    const token = cap.split("=")[1]!;
    const record = await db.idempotencyRecord.findFirstOrThrow({
      where: { response: { path: ["orderNumber"], equals: placed.orderNumber } },
    });
    const stored = await db.order.findUniqueOrThrow({ where: { id: record.resourceId! } });
    expect(Buffer.from(stored.confirmationHash!)).toEqual(confirmationHash(token));
    expect(stored.confirmationExpiresAt!.getTime() - stored.createdAt.getTime()).toBeGreaterThan(
      1790000,
    );
    expect(JSON.stringify(record.response)).not.toContain(token);
    expect(Buffer.from(record.replayCookieMaterial!).toString()).not.toContain(token);
    const response = await confirmation(cap);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const snapshot = orderConfirmationResponseSchema.parse(await response.json());
    expect(snapshot.orderNumber).toBe(placed.orderNumber);
    expect(snapshot.items[0]?.name).toBe("Synthetic product");
    expect(snapshot.address.building).toBe("Synthetic Tower");
    const text = JSON.stringify(snapshot);
    for (const secret of [stored.customerName, stored.customerPhoneE164, stored.id, token])
      expect(text).not.toContain(secret);
    const retry = await post(body, sent);
    expect(await retry.json()).toEqual(placed);
    expect(retry.headers.get("set-cookie")?.split(";", 1)[0]).toBe(cap);
  });
  it("denies missing, malformed, forged, duplicate and URL-only capabilities", async () => {
    const body = await order(cart);
    const created = await post(body);
    const set = created.headers.get("set-cookie")!.split(";", 1)[0]!;
    for (const cap of [
      undefined,
      `${ORDER_COOKIE}=bad`,
      `${ORDER_COOKIE}=${randomBytes(32).toString("base64url")}`,
      set + "; " + set,
      cookie,
    ])
      expect((await confirmation(cap)).status).toBe(401);
    expect((await confirmation(undefined, "?orderNumber=IH-001001")).status).toBe(400);
    expect((await confirmation(set, "?token=ignored")).status).toBe(400);
  });
  it("keeps each capability scoped to its own order; acknowledgement replaces the browser cookie", async () => {
    const one = await post(await order(cart)),
      two = await post(await order(cart));
    const a = storeOrderResponseSchema.parse(await one.json()),
      b = storeOrderResponseSchema.parse(await two.json());
    const ca = one.headers.get("set-cookie")!.split(";", 1)[0]!,
      cb = two.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(ca).not.toBe(cb);
    expect(
      orderConfirmationResponseSchema.parse(await (await confirmation(ca)).json()).orderNumber,
    ).toBe(a.orderNumber);
    expect(
      orderConfirmationResponseSchema.parse(await (await confirmation(cb)).json()).orderNumber,
    ).toBe(b.orderNumber);
  });
  it("expires private access, erases ciphertext and still replays success without another order", async () => {
    const body = await order(cart),
      sent = { key: attemptKey() },
      first = await post(body, sent);
    const placed = await first.json();
    const cap = first.headers.get("set-cookie")!.split(";", 1)[0]!;
    const stored = await db.order.findFirstOrThrow({
      where: { confirmationHash: new Uint8Array(confirmationHash(cap.split("=")[1]!)) },
    });
    const before = await footprint();
    await expect(
      pool.query(
        "UPDATE idempotency_records SET replay_cookie_material=NULL,replay_cookie_expires_at=NULL WHERE resource_id=$1",
        [stored.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Advance only this synthetic fixture's capability clock; production guards stay enabled.
    await pool.query(
      "ALTER TABLE orders DISABLE TRIGGER USER; ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_cookie_guard",
    );
    try {
      await pool.query(
        "UPDATE orders SET confirmation_expires_at=statement_timestamp()-interval '1 microsecond' WHERE id=$1",
        [stored.id],
      );
      await pool.query(
        "UPDATE idempotency_records SET replay_cookie_expires_at=statement_timestamp()-interval '1 microsecond' WHERE resource_id=$1",
        [stored.id],
      );
    } finally {
      await pool.query(
        "ALTER TABLE orders ENABLE TRIGGER USER; ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_cookie_guard",
      );
    }
    expect((await confirmation(cap)).status).toBe(401);
    expect(await clearExpiredConfirmationReplay(db)).toBeGreaterThanOrEqual(1);
    const replay = await post(body, sent);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(placed);
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(await footprint()).toEqual(before);
    const record = await db.idempotencyRecord.findFirstOrThrow({
      where: { resourceId: stored.id },
    });
    expect(record.replayCookieMaterial).toBeNull();
    expect(record.response).toEqual(placed);
    await expect(
      pool.query(
        "UPDATE idempotency_records SET replay_cookie_material=$1,replay_cookie_expires_at=statement_timestamp()+interval '1 minute' WHERE resource_id=$2",
        [Buffer.alloc(40), stored.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("bounds capability guessing by client address", async () => {
    const ip = address();
    for (let n = 0; n < 60; n++) expect((await confirmation(undefined, "", ip)).status).toBe(401);
    expect((await confirmation(undefined, "", ip)).status).toBe(429);
    expect((await confirmation(undefined)).status).toBe(401);
  });
  it("restores an acknowledged or lost-response cookie after API restart/key rotation without repeating writes", async () => {
    const body = await order(cart),
      sent = { key: attemptKey() },
      first = await post(body, sent);
    const placed = storeOrderResponseSchema.parse(await first.json());
    const cap = first.headers.get("set-cookie")!.split(";", 1)[0]!;
    const before = await footprint();
    const next = { keyId: "c2", secret: randomBytes(32).toString("base64url") };
    for (const keys of [[next, ...env.ORDER_CONFIRMATION_KEYS], [next]]) {
      const other = await createApp(
        { ...env, ORDER_CONFIRMATION_KEYS: keys },
        { pool, database: db },
      );
      await other.listen(0, "127.0.0.1");
      try {
        const response = await post(body, { ...sent, to: await other.getUrl() });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(placed);
        if (keys.length > 1) expect(response.headers.get("set-cookie")?.split(";", 1)[0]).toBe(cap);
        else expect(response.headers.get("set-cookie")).toBeNull();
        expect(await footprint()).toEqual(before);
      } finally {
        await other.close();
      }
    }
  });

  // --- Checkout correctness gate (roadmap step 82): the remaining cases, over HTTP. ---
  it("gate: repeated lines for one variant are one line, one sale and one request", async () => {
    const item2 = await variant(3000n, 10);
    const whole = [{ variantId: item2.id, quantity: 5 }];
    const split = [
      { variantId: item2.id, quantity: 2 },
      { variantId: item2.id, quantity: 3 },
    ];
    const body = await order({ lines: whole }, { lines: split });
    const sent = { key: attemptKey() };
    const first = await post(body, sent);
    expect(first.status).toBe(201);
    const placed = storeOrderResponseSchema.parse(await first.json());
    // 5 × 30.00 + 15.00 delivery: the split lines were priced as one line of five.
    expect(placed.totalFils).toBe(16500);
    const stored = await db.order.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
    expect(stored.items.map((line) => [line.variantId, line.quantity])).toEqual([[item2.id, 5]]);
    expect(await stockOf(item2.id)).toBe(5);
    expect(
      await db.stockMovement.count({ where: { orderId: stored.id, variantId: item2.id } }),
    ).toBe(1);
    // The same order written as one line is the same request, not a conflict.
    const again = await post({ ...body, lines: whole }, sent);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(placed);
    expect(await stockOf(item2.id)).toBe(5);
    // Repeats cannot be used to get past the per-item limit.
    const over = [
      { variantId: item2.id, quantity: ORDER_LIMITS.maxLineQuantity },
      { variantId: item2.id, quantity: 1 },
    ];
    expect((await post({ ...body, lines: over })).status).toBe(400);
    expect(await stockOf(item2.id)).toBe(5);
  });

  it("gate: shoppers racing over HTTP for the last unit get one order between them", async () => {
    const last = await variant(9000n, 1);
    const bodies = [];
    for (let i = 0; i < 6; i++)
      bodies.push(await order({ lines: [{ variantId: last.id, quantity: 1 }] }));
    const before = await footprint();
    const answers = await Promise.all(
      bodies.map(async (body) => {
        const response = await post(body);
        return [response.status, (await response.json()) as { error?: { code: string } }] as const;
      }),
    );
    expect(answers.filter(([status]) => status === 201)).toHaveLength(1);
    for (const [status, answer] of answers)
      if (status !== 201) expect([status, answer.error?.code]).toEqual([409, "INSUFFICIENT_STOCK"]);
    expect(await stockOf(last.id)).toBe(0);
    const after = await footprint();
    // The five who lost left nothing behind: no order, sale, customer or stored answer.
    expect(after).toMatchObject({
      orders: before.orders + 1,
      sales: before.sales + 1,
      customers: before.customers + 1,
      idempotency: before.idempotency + 1,
    });
  });

  it("gate: a burst of wrong codes sent at once is bounded and then shut out", async () => {
    const ip = address();
    const priced = { lines: cart.lines, areaId };
    const burst = await Promise.all(
      Array.from({ length: 25 }, (_, n) => quote({ ...priced, couponCode: "BURST" + n }, ip)),
    );
    const statuses = burst.map((response) => response.status);
    // Sent together, more than ten can be answered (ADR 0046); never more than were sent,
    // and never anything but "invalid" or "too many".
    expect(statuses.every((status) => status === 409 || status === 429)).toBe(true);
    expect(statuses.filter((status) => status === 409).length).toBeGreaterThanOrEqual(10);
    // Once the answers are in, the budget is spent: no code is looked at, right or wrong.
    await refusal(await quote({ ...priced, couponCode: "ROUTE10" }, ip), 429, "RATE_LIMITED");
    await refusal(await quote({ ...priced, couponCode: "BURSTX" }, ip), 429, "RATE_LIMITED");
    // The per-minute quote budget of thirty caps the whole minute for this address: at most
    // five of these can still be answered after the twenty-five of the burst.
    const more = await Promise.all(
      Array.from({ length: 10 }, () => quote({ ...priced, couponCode: null }, ip)),
    );
    expect(more.filter((response) => response.status === 200).length).toBeLessThanOrEqual(5);
    expect(more.some((response) => response.status === 429)).toBe(true);
  });

  // The order route never talks to queue Redis, so this cannot fail on a queue outage; what it
  // shows is where the work waits: an event and two pending effects, in PostgreSQL. That the
  // worker picks them up after an outage is shown in apps/worker/src/checkout-gate.int.test.ts.
  it("gate: an order leaves its event and its effects pending in PostgreSQL, with no queue reachable", async () => {
    const offline = await createApp(
      { ...env, QUEUE_REDIS_URL: "redis://127.0.0.1:1" },
      { pool, database: db },
    );
    await offline.listen(0, "127.0.0.1");
    try {
      const response = await post(await order(cart), { to: await offline.getUrl() });
      expect(response.status).toBe(201);
      const stored = await db.order.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
      const event = await db.outboxEvent.findFirstOrThrow({
        where: { aggregateId: stored.id, eventType: "order.created" },
        include: { effects: true },
      });
      expect(stored.status).toBe("pending");
      expect(event.completedAt).toBeNull();
      expect(event.effects.map((effect) => [effect.consumer, effect.status]).sort()).toEqual([
        ["analytics_rollup", "pending"],
        ["email", "pending"],
        ["notification", "pending"],
      ]);
    } finally {
      await offline.close();
    }
  });
});
