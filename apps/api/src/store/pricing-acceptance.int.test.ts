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
import type {
  CouponResponse,
  ProductVariantsResponse,
  StoreDeliveryResponse,
  StoreQuoteResponse,
} from "@ih/contracts";
import {
  couponCountMismatches,
  createDatabase,
  createPool,
  lockOrder,
  lockQuoteForOrder,
  redeemCoupon,
  releaseCouponRedemption,
  stockReconciliationMismatches,
  withTransaction,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { DeliveryUnavailableError } from "@ih/domain";
import {
  AGE_COOKIE,
  Argon2PasswordHasher,
  ageTicketPublicKey,
  ageTicketSigner,
  checkAcceptedQuote,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CartQuoteService, quoteFacts } from "./cart-quote.service";

/**
 * Pricing and promotion acceptance pass (roadmap step 72, acceptance PRICE-01 to PRICE-05).
 * Module tests cover each rule in depth; this file walks the cases the roadmap names across
 * modules, the way they meet in production: the Owner configures delivery, prices and coupons
 * through the admin API, and a shopper is quoted through the store API. Order placement does
 * not exist yet (M7), so "an order" here is the order transaction's quote step.
 * Products are published by a direct write: publishing through the API needs a processed
 * image and is covered by the publication and media tests.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-pricing-acceptance-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const STORE = "http://localhost:8080";
const PASSWORD = "copper-lantern-river-71";
const POLICY = "pricing-acceptance-1";
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
  ADMIN_ORIGINS: ADMIN,
  STOREFRONT_ORIGINS: STORE,
});
const ageCookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base: string;
let quotes: CartQuoteService;
let ownerCookie = "";
let ownerId = "";
let brandId = "";
let categoryId = "";
let ip = 10;
const unique = () => randomUUID().slice(0, 8);
const admin = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      cookie: ownerCookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ok = async <T>(response: Response, status = 200) => {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
/** Each call comes from a new address, like different shoppers. */
const store = (path: string, body?: unknown) =>
  fetch(`${base}/v1/store${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: ageCookie,
      "x-ih-client-ip": `198.51.100.${(ip = (ip % 250) + 1)}`,
      ...(body === undefined ? {} : { origin: STORE, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const quote = (body: unknown) => store("/cart/quote", body);
const quoted = async (body: unknown) => ok<StoreQuoteResponse>(await quote(body));

/** A published product with one variant per entry, built through the admin API. */
async function product(
  basePriceFils: number,
  variants: Array<{ flavour: string; overrideFils?: number; stock?: number }>,
) {
  const created = await ok<{ id: string }>(
    await admin("/products", "POST", {
      name: "Acceptance product " + unique(),
      slug: "acceptance-" + unique(),
      brandId,
      categoryId,
      type: "disposable",
      puffCount: 7000,
      basePriceFils,
      compareAtPriceFils: null,
      description: "Synthetic description of an acceptance product.",
      isNew: false,
      specs: {
        liquidMl: "12.5",
        batteryMah: 650,
        rechargeable: true,
        charging: "USB-C",
        extra: [],
      },
    }),
    201,
  );
  await ok(
    await admin(`/products/${created.id}/options`, "PUT", {
      productVersion: 1,
      options: [{ name: "flavour", values: variants.map((item) => item.flavour) }],
    }),
  );
  for (const item of variants)
    await ok(
      await admin(`/products/${created.id}/variants`, "POST", {
        sku: "ACC-" + unique().toUpperCase(),
        attributes: { flavour: item.flavour },
        priceOverrideFils: item.overrideFils ?? null,
        lowStockThreshold: 0,
        active: true,
      }),
      201,
    );
  const listed = async () =>
    (await ok<ProductVariantsResponse>(await admin(`/products/${created.id}/variants`))).variants;
  for (const item of variants) {
    if (!item.stock) continue;
    const variant = (await listed()).find((row) => row.attributes.flavour === item.flavour)!;
    await ok(
      await admin(`/inventory/${variant.id}/adjustments`, "POST", {
        commandId: randomUUID(),
        delta: item.stock,
        reason: "RESTOCK",
      }),
    );
  }
  // A ready image and the publish flag, written directly (see the note at the top), so the
  // product is one the admin API keeps editable while published.
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
       declared_bytes, state, observed_bytes, width, height, sha256, upload_expires_at)
     VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'ready', 10, 100, 200,
       repeat('a', 64), statement_timestamp())`,
    [assetId, created.id, ownerId],
  );
  await db.productImage.create({
    data: {
      mediaAssetId: assetId,
      productId: created.id,
      assetKey: `media/${assetId}.webp`,
      width: 100,
      height: 200,
      mime: "image/webp",
      isPrimary: true,
    },
  });
  await pool.query("UPDATE products SET status='published' WHERE id=$1", [created.id]);
  const rows = await listed();
  const byFlavour = new Map(rows.map((row) => [row.attributes.flavour, row]));
  return { id: created.id, variant: (flavour: string) => byFlavour.get(flavour)! };
}
async function setOverride(productId: string, flavour: string, priceOverrideFils: number | null) {
  const rows = (await ok<ProductVariantsResponse>(await admin(`/products/${productId}/variants`)))
    .variants;
  const row = rows.find((item) => item.attributes.flavour === flavour)!;
  return ok(
    await admin(`/products/${productId}/variants/${row.id}`, "PATCH", {
      version: row.version,
      sku: row.sku,
      priceOverrideFils,
      lowStockThreshold: row.lowStockThreshold,
      active: row.active,
      isDefault: row.isDefault,
    }),
  );
}
interface Area {
  id: string;
  name: string;
  version: number;
}
async function area(code: string, name: string, emirate: string, active = true) {
  return ok<Area>(await admin("/delivery-areas", "POST", { code, name, emirate, active }), 201);
}
async function setArea(target: Area, active: boolean) {
  const updated = await ok<Area>(
    await admin(`/delivery-areas/${target.id}`, "PATCH", {
      version: target.version,
      name: target.name,
      active,
    }),
  );
  target.version = updated.version;
}
let feeVersion = 0;
async function setFee(flatFeeFils: number) {
  const updated = await ok<{ version: number }>(
    await admin("/delivery-areas/configuration", "PATCH", {
      version: feeVersion,
      value: { flatFeeFils, etaText: "Synthetic ETA", freeThresholdFils: null },
    }),
  );
  feeVersion = updated.version;
}
const coupon = (code: string, changes: Record<string, unknown> = {}) =>
  admin("/coupons", "POST", {
    code,
    percentBps: 1500,
    minSubtotalFils: 0,
    startsAt: null,
    expiresAt: null,
    active: true,
    usageLimit: null,
    ...changes,
  });
/** What the order transaction would decide about a shown quote (step 76 wires this in). */
const orderDecision = (shown: StoreQuoteResponse, input: Parameters<typeof lockQuoteForOrder>[1]) =>
  withTransaction(db, async (tx) =>
    checkAcceptedQuote(
      shown.quote.token,
      quotes.keys,
      new Date(),
      quoteFacts(await lockQuoteForOrder(tx, input)),
    ),
  );

describe("pricing and promotion acceptance through the real API and PostgreSQL", () => {
  let marina: Area;
  let corniche: Area;
  let closed: Area;
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    const owner = await db.staffUser.create({
      data: {
        email: "pricing-acceptance@iqoshaven.test",
        name: "Acceptance Owner",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    ownerId = owner.id;
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    quotes = app.get(CartQuoteService);
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
      body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    ownerCookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const parent = async (path: string, name: string) =>
      (
        await ok<{ id: string }>(
          await admin(path, "POST", { name, slug: "acc-" + unique(), active: true }),
          201,
        )
      ).id;
    brandId = await parent("/brands", "Acceptance brand");
    categoryId = await parent("/categories", "Acceptance category");
    // Before the Owner configures delivery nothing can be quoted.
    expect(await ok<StoreDeliveryResponse>(await store("/delivery"))).toEqual({
      feeFils: null,
      etaText: null,
      freeThresholdFils: null,
      areas: [],
    });
    marina = await area("acc_marina", "Acceptance Marina", "dubai");
    corniche = await area("acc_corniche", "Acceptance Corniche", "abu_dhabi");
    closed = await area("acc_closed", "Acceptance Closed", "sharjah", false);
    await setFee(1500);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("PRICE-01: merges repeated lines and allocates one half-up discount deterministically", async () => {
    const kit = await product(12999, [
      { flavour: "grape", stock: 9 },
      { flavour: "mint", overrideFils: 4500, stock: 9 },
      { flavour: "cola", overrideFils: 3333, stock: 9 },
    ]);
    await ok(await coupon("ACC15"), 201);
    const grape = kit.variant("grape").id;
    const mint = kit.variant("mint").id;
    const cola = kit.variant("cola").id;
    const cart = {
      lines: [
        { variantId: mint, quantity: 1 },
        { variantId: grape, quantity: 1 },
        { variantId: cola, quantity: 2 },
        { variantId: mint, quantity: 1 },
      ],
      areaId: marina.id,
      couponCode: "acc15",
    };
    const first = await quoted(cart);
    // 12999 + 2 × 4500 + 2 × 3333 = 28665; 15 % = 4299.75 → 4300; + 1500 delivery = 25865.
    expect(first).toMatchObject({
      merchandiseSubtotalFils: 28665,
      discountFils: 4300,
      deliveryFeeFils: 1500,
      totalFils: 25865,
    });
    const line = (id: string) => first.lines.find((item) => item.variantId === id)!;
    expect(line(mint)).toMatchObject({ quantity: 2, unitPriceFils: 4500, subtotalFils: 9000 });
    expect(line(grape)).toMatchObject({ quantity: 1, unitPriceFils: 12999 });
    expect(line(cola)).toMatchObject({ quantity: 2, unitPriceFils: 3333, subtotalFils: 6666 });
    // Exact shares 1949.96, 1350.08, 999.96 → rounded down 1949, 1350, 999: two fils are left
    // over and go to the two largest lost fractions (grape .9634, cola .9581).
    expect([line(grape), line(mint), line(cola)].map((item) => item.discountFils)).toEqual([
      1950, 1350, 1000,
    ]);
    expect(first.lines.reduce((sum, item) => sum + item.discountFils, 0)).toBe(first.discountFils);
    expect(first.lines.reduce((sum, item) => sum + item.totalFils, 0) + 1500).toBe(first.totalFils);
    for (const item of first.lines)
      for (const value of Object.values(item))
        if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
    // The same cart in any order, asked again, costs the same to the fil.
    const again = await quoted({ ...cart, lines: [...cart.lines].reverse() });
    expect(again.lines).toEqual(first.lines);
    expect(again.quote.fingerprint).toBe(first.quote.fingerprint);
    // There is no tax anywhere in the answer: the entered price is the price (ADR 0036).
    expect(JSON.stringify(first)).not.toMatch(/tax|vat|excise/i);
    // Quantities over the cap are refused before any arithmetic, also when split over lines.
    for (const lines of [
      [{ variantId: grape, quantity: 11 }],
      [
        { variantId: grape, quantity: 6 },
        { variantId: grape, quantity: 5 },
      ],
    ])
      expect((await quote({ ...cart, lines })).status).toBe(400);
  });
  it("PRICE-01: stays exact at the largest order the caps allow", async () => {
    const dear = await product(1_000_000_000, [{ flavour: "gold", stock: 10 }]);
    await ok(await coupon("ACC3333", { percentBps: 3333 }), 201);
    const big = await quoted({
      lines: [{ variantId: dear.variant("gold").id, quantity: 10 }],
      areaId: marina.id,
      couponCode: "ACC3333",
    });
    expect(big).toMatchObject({
      merchandiseSubtotalFils: 10_000_000_000,
      discountFils: 3_333_000_000,
      totalFils: 6_667_001_500,
    });
    // A price above the cap cannot be entered at all.
    expect((await admin("/products", "POST", { basePriceFils: 1_000_000_001 })).status).toBe(400);
  });
  it("PRICE-03: the server decides coupon eligibility; nothing is taken from the client", async () => {
    const item = await product(10000, [{ flavour: "grape", stock: 5 }]);
    const cart = (couponCode: unknown, quantity = 1) => ({
      lines: [{ variantId: item.variant("grape").id, quantity }],
      areaId: marina.id,
      couponCode,
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await ok(await coupon("ACCLATER", { startsAt: future }), 201);
    await ok(await coupon("ACCMIN", { minSubtotalFils: 20000 }), 201);
    await ok(await coupon("ACCOFF", { active: false }), 201);
    const ending = await ok<CouponResponse>(await coupon("ACCENDED", { expiresAt: future }), 201);
    // Time passes: the coupon's end is now behind the database clock.
    await pool.query(
      "UPDATE coupons SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",
      [ending.id],
    );
    for (const code of ["ACCLATER", "ACCOFF", "ACCENDED", "ACCNOSUCH"])
      expect(await errorCode(await quote(cart(code))), code).toBe("COUPON_INVALID");
    // The minimum is on merchandise before the discount; delivery (AED 15.00) does not count.
    expect(await errorCode(await quote(cart("ACCMIN", 1)))).toBe("COUPON_INVALID");
    expect(await quoted(cart("ACCMIN", 2))).toMatchObject({
      merchandiseSubtotalFils: 20000,
      discountFils: 3000,
      totalFils: 18500,
    });
    // Stacking: a second code has nowhere to go.
    for (const body of [
      cart(["ACC15", "ACCMIN"]),
      { ...cart("ACC15"), couponCodes: ["ACCMIN"] },
      { ...cart("ACC15"), secondCouponCode: "ACCMIN" },
      // Amounts and eligibility cannot be sent.
      { ...cart("ACC15"), discountFils: 9999 },
      { ...cart("ACC15"), percentBps: 9000 },
      { ...cart("ACC15"), totalFils: 1 },
    ])
      expect((await quote(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    // Unsupported types cannot be created.
    for (const unsupported of [
      { type: "fixed", amountFils: 2000 },
      { amountFils: 2000 },
      { brandId },
      { productIds: [item.id] },
      { stackable: true },
    ])
      expect((await coupon("ACC" + unique().toUpperCase(), unsupported)).status).toBe(400);
    expect(await db.coupon.count({ where: { code: { startsWith: "ACC" } } })).toBe(6);
  });
  it("PRICE-02: two orders racing for the last use of a coupon: one gets it", async () => {
    const item = await product(8000, [{ flavour: "grape", stock: 5 }]);
    const last = await ok<CouponResponse>(await coupon("ACCLAST", { usageLimit: 1 }), 201);
    const input = {
      lines: [{ variantId: item.variant("grape").id, quantity: 1 }],
      areaId: marina.id,
      couponCode: "ACCLAST",
    };
    const orderIds: string[] = [];
    for (let n = 0; n < 4; n++) orderIds.push((await seedOrder(pool)).orderId);
    const results = await Promise.allSettled(
      orderIds.map((orderId) =>
        withTransaction(db, async (tx) => {
          const locked = await lockQuoteForOrder(tx, input);
          await redeemCoupon(tx, orderId, locked.appliedCoupon!);
          return orderId;
        }),
      ),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const result of results.filter((item) => item.status === "rejected"))
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: "COUPON_LIMIT_REACHED",
      });
    // The Owner sees it used up, and a shopper is told so.
    const listed = (await ok<{ items: CouponResponse[] }>(await admin("/coupons?limit=100"))).items;
    expect(listed.find((row) => row.id === last.id)).toMatchObject({
      activeRedemptions: 1,
      status: "used_up",
    });
    expect(await errorCode(await quote(input))).toBe("COUPON_LIMIT_REACHED");
    // A cancellation gives the use back once; the next shopper can then be quoted with it.
    const winner = (won[0] as PromiseFulfilledResult<string>).value;
    const released = await Promise.all(
      [1, 2, 3].map(() =>
        withTransaction(db, async (tx) => {
          await lockOrder(tx, winner);
          return releaseCouponRedemption(tx, winner);
        }),
      ),
    );
    expect(released.filter(Boolean)).toHaveLength(1);
    expect(await quoted(input)).toMatchObject({ discountFils: 1200 });
    expect(await couponCountMismatches(db)).toEqual([]);
  });
  it("PRICE-04: one flat fee everywhere, no free delivery, and a closed area is refused", async () => {
    const item = await product(5000, [{ flavour: "grape", stock: 9 }]);
    const cart = (areaId: string, quantity = 1) => ({
      lines: [{ variantId: item.variant("grape").id, quantity }],
      areaId,
      couponCode: null,
    });
    // The same fee in another emirate and for a larger order.
    for (const [areaId, quantity, total] of [
      [marina.id, 1, 6500],
      [corniche.id, 1, 6500],
      [corniche.id, 9, 46500],
    ] as const)
      expect(await quoted(cart(areaId, quantity))).toMatchObject({
        deliveryFeeFils: 1500,
        freeDeliveryThresholdFils: null,
        totalFils: total,
      });
    // A free-delivery threshold cannot be configured.
    expect(
      (
        await admin("/delivery-areas/configuration", "PATCH", {
          version: feeVersion,
          value: { flatFeeFils: 1500, etaText: "Synthetic ETA", freeThresholdFils: 10000 },
        })
      ).status,
    ).toBe(400);
    // Shoppers are offered active areas only, and an inactive or unknown one cannot be quoted.
    const offered = await ok<StoreDeliveryResponse>(await store("/delivery"));
    expect(offered).toMatchObject({ feeFils: 1500, freeThresholdFils: null });
    expect(offered.areas.map((row) => row.name)).toEqual([
      "Acceptance Corniche",
      "Acceptance Marina",
    ]);
    for (const areaId of [closed.id, randomUUID()])
      expect(await errorCode(await quote(cart(areaId)))).toBe("AREA_UNAVAILABLE");
    // The Owner closes an area: it leaves the list and the next quote is refused.
    await setArea(corniche, false);
    expect((await ok<StoreDeliveryResponse>(await store("/delivery"))).areas).toHaveLength(1);
    expect(await errorCode(await quote(cart(corniche.id)))).toBe("AREA_UNAVAILABLE");
    await setArea(corniche, true);
    expect((await quote(cart(corniche.id))).status).toBe(200);
  });
  it("PRICE-05: any change after a quote needs a new acceptance; nothing is charged silently", async () => {
    const item = await product(8000, [{ flavour: "grape", stock: 5 }]);
    await ok(await coupon("ACCCHANGE", { percentBps: 1000 }), 201);
    const input = {
      lines: [{ variantId: item.variant("grape").id, quantity: 2 }],
      areaId: marina.id,
      couponCode: "ACCCHANGE",
    };
    const shown = await quoted(input);
    expect(shown).toMatchObject({ discountFils: 1600, totalFils: 15900 });
    expect(await orderDecision(shown, input)).toBe("ACCEPTED");
    const changedThenRestored = async (
      change: () => Promise<unknown>,
      restore: () => Promise<unknown>,
    ) => {
      await change();
      expect(await orderDecision(shown, input)).toBe("QUOTE_CHANGED");
      // The shopper is shown the new total under a new fingerprint.
      const fresh = await quoted(input);
      expect(fresh.quote.fingerprint).not.toBe(shown.quote.fingerprint);
      expect(fresh.totalFils).not.toBe(shown.totalFils);
      expect(await orderDecision(fresh, input)).toBe("ACCEPTED");
      await restore();
      expect(await orderDecision(shown, input)).toBe("ACCEPTED");
    };
    // Price up, price down (through the admin API), the fee, and the coupon's percentage.
    await changedThenRestored(
      () => setOverride(item.id, "grape", 8100),
      () => setOverride(item.id, "grape", null),
    );
    await changedThenRestored(
      () => setOverride(item.id, "grape", 7999),
      () => setOverride(item.id, "grape", null),
    );
    await changedThenRestored(
      () => setFee(2000),
      () => setFee(1500),
    );
    const row = (
      await ok<{ items: CouponResponse[] }>(await admin("/coupons?limit=100"))
    ).items.find((candidate) => candidate.code === "ACCCHANGE")!;
    const terms = (percentBps: number, version: number) => ({
      version,
      percentBps,
      minSubtotalFils: 0,
      startsAt: null,
      expiresAt: null,
      active: true,
      usageLimit: null,
    });
    await changedThenRestored(
      async () => ok(await admin(`/coupons/${row.id}`, "PATCH", terms(2000, row.version))),
      async () => ok(await admin(`/coupons/${row.id}`, "PATCH", terms(1000, row.version + 1))),
    );
    // A different area is a different quote, even at the same fee.
    expect(await orderDecision(shown, { ...input, areaId: corniche.id })).toBe("QUOTE_CHANGED");
    // The shopper removing the code, or changing a quantity, is not what was accepted either.
    expect(await orderDecision(shown, { ...input, couponCode: null })).toBe("QUOTE_CHANGED");
    expect(
      await orderDecision(shown, {
        ...input,
        lines: [{ variantId: item.variant("grape").id, quantity: 3 }],
      }),
    ).toBe("QUOTE_CHANGED");
    // The area closing ends the order outright; an old quote is no way around it.
    await setArea(marina, false);
    await expect(orderDecision(shown, input)).rejects.toBeInstanceOf(DeliveryUnavailableError);
    await setArea(marina, true);
    // An acceptance is only good for a while.
    expect(
      await withTransaction(db, async (tx) =>
        checkAcceptedQuote(
          shown.quote.token,
          quotes.keys,
          new Date(Date.parse(shown.quote.expiresAt)),
          quoteFacts(await lockQuoteForOrder(tx, input)),
        ),
      ),
    ).toBe("QUOTE_EXPIRED");
    // A token is not a discount: one made for a cheaper cart does not fit this one.
    const cheaper = await quoted({ ...input, lines: [{ ...input.lines[0]!, quantity: 1 }] });
    expect(await orderDecision(cheaper, input)).toBe("QUOTE_CHANGED");
  });
  it("M6 gate: quoting reserves nothing", async () => {
    const item = await product(4900, [{ flavour: "grape", stock: 1 }]);
    const variantId = item.variant("grape").id;
    const cart = (quantity: number) => ({
      lines: [{ variantId, quantity }],
      areaId: marina.id,
      couponCode: "ACC15",
    });
    const before = await db.coupon.findUniqueOrThrow({ where: { code: "ACC15" } });
    // Twenty shoppers are quoted the last unit at the same time.
    const answers = await Promise.all(Array.from({ length: 20 }, () => quoted(cart(1))));
    for (const answer of answers)
      expect(answer).toMatchObject({ totalFils: 5665, insufficientStock: [] });
    // Asking for more than exists is priced and named, not reserved or refused.
    expect(await quoted(cart(3))).toMatchObject({ insufficientStock: [variantId] });
    expect((await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand).toBe(1);
    expect(await db.stockMovement.count({ where: { variantId } })).toBe(1);
    expect(await db.stockMovement.count({ where: { delta: { lt: 0 } } })).toBe(0);
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "ACC15" } })).activeRedemptions,
    ).toBe(before.activeRedemptions);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await couponCountMismatches(db)).toEqual([]);
  });
});
