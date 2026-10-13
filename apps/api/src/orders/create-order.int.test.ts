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
  checkoutAddressSchema,
  checkoutContactSchema,
  type StoreQuoteResponse,
} from "@ih/contracts";
import {
  couponCountMismatches,
  createDatabase,
  createPool,
  deleteExpiredIdempotencyRecords,
  adjustStock,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  InsufficientStockError,
  listStockMovements,
  stockReconciliationMismatches,
  VariantUnavailableError,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { ageTicketPublicKey, ageTicketSigner, signQuote } from "@ih/platform";
import { DeliveryUnavailableError } from "@ih/domain";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CartQuoteService } from "../store/cart-quote.service";
import { CreateOrderService } from "./create-order.service";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-create-order-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "order-test-1";
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
let app: INestApplication;
let quotes: CartQuoteService;
let staffId = "";
let areaId = "";
let closedAreaId = "";
let orders: CreateOrderService;
const key = () => "t" + randomUUID().replaceAll("-", "").slice(0, 16);
const attemptKey = () => randomBytes(24).toString("base64url");
let serial = 0;
const phone = () => "050 610 " + String(++serial).padStart(4, "0");
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
  return { id: row.id, productId: product.id, brandId: brand.id };
}
const coupon = (code: string, extra: { usageLimit?: number } = {}) =>
  db.coupon.create({
    data: { code, percentBps: 1000, active: true, updatedBy: staffId, ...extra },
  });
const address = (changes: Record<string, unknown> = {}) =>
  checkoutAddressSchema.parse({
    areaId,
    type: "apartment",
    building: "Synthetic Tower",
    unit: "1204",
    makani: "12345 67890",
    notes: "Synthetic note",
    ...changes,
  });
interface Cart {
  lines: Array<{ variantId: string; quantity: number }>;
  couponCode?: string | null;
  areaId?: string;
}
/** What a shopper does: gets a total, then places the order with the token for it. */
async function checkout(cart: Cart, changes: Record<string, unknown> = {}) {
  const shown = await quotes.quote({
    lines: cart.lines,
    areaId: cart.areaId ?? areaId,
    couponCode: cart.couponCode ?? null,
  });
  return command(cart, shown, changes);
}
function command(cart: Cart, shown: StoreQuoteResponse, changes: Record<string, unknown> = {}) {
  return {
    idempotencyKey: attemptKey(),
    contact: checkoutContactSchema.parse({ name: "Synthetic Buyer", phone: phone() }),
    address: address(cart.areaId ? { areaId: cart.areaId } : {}),
    lines: cart.lines,
    couponCode: cart.couponCode ?? null,
    quoteToken: shown.quote.token,
    requestId: randomUUID(),
    ...changes,
  } as Parameters<CreateOrderService["place"]>[0];
}
const stockOf = async (variantId: string) =>
  (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stockOnHand;
/** Everything an order writes, counted, to show that a refused order wrote none of it. */
const footprint = async () => ({
  orders: await db.order.count(),
  items: await db.orderItem.count(),
  history: await db.orderStatusHistory.count(),
  sales: await db.stockMovement.count({ where: { reason: "SALE" } }),
  redemptions: await db.couponRedemption.count(),
  customers: await db.customer.count(),
  addresses: await db.customerAddress.count(),
  idempotency: await db.idempotencyRecord.count(),
  audit: await db.auditLog.count({ where: { entityType: "order" } }),
  events: (await pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n as number,
});

describe("atomic order creation (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "create-order@iqoshaven.test",
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
    app = await createApp(env, { pool, database: db });
    await app.init();
    quotes = app.get(CartQuoteService);
    orders = app.get(CreateOrderService);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("writes the order, its lines, history, stock, coupon use, customer, audit and event together", async () => {
    const kit = await variant(12999n, { stock: 5, name: "Order Probe Kit" });
    const pods = await variant(4500n, { stock: 9 });
    await db.variant.update({ where: { id: pods.id }, data: { lowStockThreshold: 7 } });
    await coupon("ORDER10");
    const cart = {
      lines: [
        { variantId: pods.id, quantity: 1 },
        { variantId: kit.id, quantity: 1 },
        { variantId: pods.id, quantity: 1 },
      ],
      couponCode: "ORDER10",
    };
    const before = await footprint();
    const placing = await checkout(cart);
    const placed = await orders.place(placing);
    // 12999 + 2 × 4500 = 21999; 10 % = 2199.9 → 2200; + 1500 delivery.
    expect(placed).toMatchObject({ replayed: false, response: { totalFils: 21299 } });
    expect(placed.response.orderNumber).toMatch(/^IH-\d{6}$/);
    // The answer holds nothing personal.
    expect(Object.keys(placed.response).sort()).toEqual(["orderNumber", "placedAt", "totalFils"]);
    const order = await db.order.findUniqueOrThrow({
      where: { id: placed.orderId! },
      include: { items: true, history: true, couponRedemption: true, stockMovements: true },
    });
    expect(order).toMatchObject({
      status: "pending",
      source: "storefront",
      createdBy: null,
      customerName: "Synthetic Buyer",
      customerPhoneE164: placing.contact.phone,
      areaId,
      areaCode: "synthetic_open",
      areaName: "Synthetic synthetic_open",
      areaEmirate: "sharjah",
      addressType: "apartment",
      addressBuilding: "Synthetic Tower",
      addressUnit: "1204",
      addressStreet: null,
      addressMakani: "1234567890",
      addressNotes: "Synthetic note",
      merchandiseSubtotalFils: 21999n,
      discountFils: 2200n,
      deliveryFeeFils: 1500n,
      totalFils: 21299n,
      couponCode: "ORDER10",
      couponPercentBps: 1000,
      deliveryEtaText: "Synthetic ETA",
      areaVersion: 1,
      deliveryConfigurationVersion: 1,
      agePolicyVersion: POLICY,
      codStatus: "pending",
      creationScope: "store.checkout",
      confirmationHash: expect.any(Uint8Array),
      version: 1,
    });
    expect(order.ageConfirmedAt).toBeInstanceOf(Date);
    expect(order.quoteFingerprint).toBe(placing.quoteToken.split(".")[3]);
    // Lines: merged, with what each variant was when sold.
    const line = (id: string) => order.items.find((item) => item.variantId === id)!;
    expect(order.items).toHaveLength(2);
    expect(line(kit.id)).toMatchObject({
      productId: kit.productId,
      productName: "Order Probe Kit",
      quantity: 1,
      unitPriceFils: 12999n,
      subtotalFils: 12999n,
      discountFils: 1300n,
      totalFils: 11699n,
      productVersion: 1,
    });
    expect(line(pods.id)).toMatchObject({ quantity: 2, subtotalFils: 9000n, discountFils: 900n });
    expect(line(kit.id).sku).toBeTruthy();
    expect(line(kit.id).brandName).toMatch(/^Synthetic brand/);
    expect(order.history.map((row) => [row.fromStatus, row.toStatus, row.actorKind])).toEqual([
      [null, "pending", "customer"],
    ]);
    // Stock: one sale movement per line, and the balance moved with it.
    expect(
      order.stockMovements
        .map((row) => [row.variantId, row.delta, row.balanceAfter, row.reason, row.effect])
        .sort(),
    ).toEqual(
      [
        [kit.id, -1, 4, "SALE", "sale"],
        [pods.id, -2, 7, "SALE", "sale"],
      ].sort(),
    );
    expect(await stockOf(kit.id)).toBe(4);
    expect(await stockOf(pods.id)).toBe(7);
    // Coupon use, with its snapshot.
    expect(order.couponRedemption).toMatchObject({
      code: "ORDER10",
      percentBps: 1000,
      merchandiseSubtotalFils: 21999n,
      discountFils: 2200n,
      releasedAt: null,
    });
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "ORDER10" } })).activeRedemptions,
    ).toBe(1);
    // Customer, saved address and first-order time.
    const customer = await db.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      include: { addresses: true },
    });
    expect(customer).toMatchObject({
      phoneE164: placing.contact.phone,
      displayName: "Synthetic Buyer",
    });
    expect(customer.firstOrderAt).toBeInstanceOf(Date);
    expect(customer.addresses).toHaveLength(1);
    // Exactly one of each side record, in the same commit.
    const after = await footprint();
    expect(after).toEqual({
      orders: before.orders + 1,
      items: before.items + 2,
      history: before.history + 1,
      sales: before.sales + 2,
      redemptions: before.redemptions + 1,
      customers: before.customers + 1,
      addresses: before.addresses + 1,
      idempotency: before.idempotency + 1,
      audit: before.audit + 1,
      // order.created, plus inventory.low for the pods (9 → 7 crosses the threshold of 7).
      events: before.events + 2,
    });
    const events = await pool.query(
      "SELECT event_type, aggregate_id, payload FROM outbox_events ORDER BY created_at DESC, id DESC LIMIT 2",
    );
    expect(events.rows.map((row) => row.event_type).sort()).toEqual([
      "inventory.low",
      "order.created",
    ]);
    expect(events.rows.find((row) => row.event_type === "order.created")).toMatchObject({
      aggregate_id: order.id,
      payload: { orderId: order.id },
    });
    // The audit entry says what was ordered, never who ordered it; no key or token anywhere.
    const audit = await pool.query(
      "SELECT action, actor_type, diff::text AS diff FROM audit_log WHERE entity_type='order' AND entity_id=$1",
      [order.id],
    );
    expect(audit.rows[0]).toMatchObject({ action: "order.created", actor_type: "system" });
    for (const secret of [
      placing.contact.phone,
      "Synthetic Buyer",
      "Synthetic Tower",
      placing.idempotencyKey,
    ])
      expect(audit.rows[0].diff).not.toContain(secret);
    const dump = JSON.stringify(
      (await pool.query("SELECT row_to_json(o)::text AS j FROM orders o WHERE id=$1", [order.id]))
        .rows,
    );
    expect(dump).not.toContain(placing.idempotencyKey);
    expect(dump).not.toContain(placing.quoteToken);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await couponCountMismatches(db)).toEqual([]);
  });
  it("replays the same attempt and refuses a changed one, without a second order", async () => {
    const item = await variant(8000n, { stock: 5 });
    const cart = { lines: [{ variantId: item.id, quantity: 2 }] };
    const placing = await checkout(cart);
    const first = await orders.place(placing);
    const after = await footprint();
    // A retry of the same request, sequentially and five at once.
    expect(await orders.place({ ...placing, requestId: randomUUID() })).toEqual({
      ...first,
      replayed: true,
    });
    const again = await Promise.all(
      Array.from({ length: 5 }, () => orders.place({ ...placing, requestId: randomUUID() })),
    );
    for (const result of again) expect(result).toEqual({ ...first, replayed: true });
    // The same key with anything different is a conflict.
    for (const changed of [
      { lines: [{ variantId: item.id, quantity: 1 }] },
      {
        contact: checkoutContactSchema.parse({
          name: "Someone Else",
          phone: placing.contact.phone,
        }),
      },
      { address: address({ unit: "9999" }) },
      { couponCode: "OTHER10" },
    ])
      await expect(orders.place({ ...placing, ...changed })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    expect(await footprint()).toEqual(after);
    expect(await stockOf(item.id)).toBe(3);
  });
  it("creates one order when the same attempt arrives many times at once", async () => {
    const item = await variant(8000n, { stock: 5 });
    const placing = await checkout({ lines: [{ variantId: item.id, quantity: 1 }] });
    const before = await footprint();
    const results = await Promise.all(Array.from({ length: 6 }, () => orders.place(placing)));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.orderId)).size).toBe(1);
    expect((await footprint()).orders).toBe(before.orders + 1);
    expect(await stockOf(item.id)).toBe(4);
  });
  it("sells the last unit once when different shoppers race for it", async () => {
    const last = await variant(8000n, { stock: 1 });
    const cart = { lines: [{ variantId: last.id, quantity: 1 }] };
    const attempts = await Promise.all(Array.from({ length: 8 }, () => checkout(cart)));
    const before = await footprint();
    const results = await Promise.allSettled(attempts.map((attempt) => orders.place(attempt)));
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const result of lost) {
      expect(result.reason).toBeInstanceOf(InsufficientStockError);
      expect(result.reason).toMatchObject({ code: "INSUFFICIENT_STOCK", variantIds: [last.id] });
    }
    expect(await stockOf(last.id)).toBe(0);
    // The seven refused attempts left nothing: no order, customer, address or answer.
    const after = await footprint();
    expect(after).toMatchObject({
      orders: before.orders + 1,
      customers: before.customers + 1,
      addresses: before.addresses + 1,
      idempotency: before.idempotency + 1,
      sales: before.sales + 1,
    });
    // A refused attempt can be retried with the same key once stock is back.
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 1, 'RESTOCK', $2)",
      [last.id, randomUUID()],
    );
    const loser = attempts[results.findIndex((result) => result.status === "rejected")]!;
    expect((await orders.place(loser)).replayed).toBe(false);
    expect(await stockOf(last.id)).toBe(0);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });
  it("gives the last use of a coupon to one of the racing orders", async () => {
    const item = await variant(8000n, { stock: 20 });
    await coupon("ORDERLAST", { usageLimit: 1 });
    const cart = { lines: [{ variantId: item.id, quantity: 1 }], couponCode: "ORDERLAST" };
    const attempts = await Promise.all(Array.from({ length: 5 }, () => checkout(cart)));
    const results = await Promise.allSettled(attempts.map((attempt) => orders.place(attempt)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((item) => item.status === "rejected"))
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: "COUPON_LIMIT_REACHED",
      });
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "ORDERLAST" } })).activeRedemptions,
    ).toBe(1);
    // Only the winner took stock.
    expect(await stockOf(item.id)).toBe(19);
    expect(await couponCountMismatches(db)).toEqual([]);
  });
  it("refuses an order whose total is no longer the one accepted, and writes nothing", async () => {
    const item = await variant(8000n, { stock: 5 });
    const cart = { lines: [{ variantId: item.id, quantity: 1 }] };
    const refused = async (work: () => Promise<unknown>, expected: unknown) => {
      const before = await footprint();
      const error = await work().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      if (typeof expected === "function") expect(error).toBeInstanceOf(expected);
      else expect(error).toMatchObject(expected as object);
      expect(await footprint()).toEqual(before);
      expect(await stockOf(item.id)).toBe(5);
    };
    // The price changed after the quote, in either direction.
    const placing = await checkout(cart);
    await pool.query("UPDATE products SET base_price_fils=8100, version=version+1 WHERE id=$1", [
      item.productId,
    ]);
    await refused(() => orders.place(placing), { code: "QUOTE_CHANGED" });
    await pool.query("UPDATE products SET base_price_fils=7900, version=version+1 WHERE id=$1", [
      item.productId,
    ]);
    await refused(() => orders.place(placing), { code: "QUOTE_CHANGED" });
    await pool.query("UPDATE products SET base_price_fils=8000, version=version+1 WHERE id=$1", [
      item.productId,
    ]);
    // A forged, altered or foreign token; a token for another cart.
    const other = await checkout({ lines: [{ variantId: item.id, quantity: 2 }] });
    for (const quoteToken of [
      "forged",
      placing.quoteToken.slice(0, -2) + "AA",
      other.quoteToken,
      placing.quoteToken.replace(
        /\.(\d{10})\./,
        (_all, expiry: string) => `.${Number(expiry) + 9999}.`,
      ),
    ])
      await refused(() => orders.place({ ...placing, idempotencyKey: attemptKey(), quoteToken }), {
        code: "QUOTE_CHANGED",
      });
    // The same key is still usable once the shopper accepts the current total.
    expect((await orders.place(placing)).replayed).toBe(false);
    expect(await stockOf(item.id)).toBe(4);
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 5, 'RESTOCK', $2)",
      [item.id, randomUUID()],
    );
    // The area closed, the product was hidden, or a line is unknown.
    const hidden = await variant(5000n, { stock: 5 });
    const hiddenAttempt = await checkout({ lines: [{ variantId: hidden.id, quantity: 1 }] });
    await pool.query("UPDATE products SET status='draft', version=version+1 WHERE id=$1", [
      hidden.productId,
    ]);
    await refused(() => orders.place(hiddenAttempt), { code: "VARIANT_UNAVAILABLE" });
    expect(await orders.place(hiddenAttempt).catch((error: unknown) => error)).toBeInstanceOf(
      VariantUnavailableError,
    );
    const closing = await checkout(cart);
    await pool.query("UPDATE delivery_areas SET active=false, version=version+1 WHERE id=$1", [
      areaId,
    ]);
    await refused(() => orders.place(closing), DeliveryUnavailableError);
    await pool.query("UPDATE delivery_areas SET active=true, version=version+1 WHERE id=$1", [
      areaId,
    ]);
    // More than is in stock: refused as a whole, naming the line.
    const greedy = await checkout({ lines: [{ variantId: item.id, quantity: 5 }] });
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, note, command_id) VALUES ($1, -2, 3, 'DAMAGE', 'Synthetic damage', $2)",
      [item.id, randomUUID()],
    );
    const before = await footprint();
    await expect(orders.place(greedy)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      variantIds: [item.id],
    });
    expect(await footprint()).toEqual(before);
    expect(await stockOf(item.id)).toBe(3);
    expect(closedAreaId).toBeTruthy();
  });
  it("refuses an expired or foreign-key token for a new order, but still replays a placed one", async () => {
    const item = await variant(8000n, { stock: 5 });
    const cart = { lines: [{ variantId: item.id, quantity: 1 }] };
    const placing = await checkout(cart);
    const fingerprint = placing.quoteToken.split(".")[3]!;
    const before = await footprint();
    // A genuine token past its expiry: refused inside the transaction, nothing written.
    const expired = signQuote(fingerprint, new Date(Date.now() - 1000), quotes.keys[0]!);
    await expect(orders.place({ ...placing, quoteToken: expired })).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
    });
    // A token signed with a key this server does not have: refused before any database work.
    const foreign = signQuote(fingerprint, new Date(Date.now() + 600_000), {
      keyId: "other",
      secret: randomBytes(32).toString("base64url"),
    });
    await expect(orders.place({ ...placing, quoteToken: foreign })).rejects.toMatchObject({
      code: "QUOTE_CHANGED",
    });
    expect(await footprint()).toEqual(before);
    // Placed with the live token; a retry that arrives after the token expired still gets the
    // same answer, because a replay needs the key and the payload, not a live token.
    const placed = await orders.place(placing);
    expect(await orders.place({ ...placing, quoteToken: expired })).toEqual({
      ...placed,
      replayed: true,
    });
    expect(await stockOf(item.id)).toBe(4);
  });
  it("refuses an inactive variant and names only the lines that are short", async () => {
    const plenty = await variant(5000n, { stock: 9 });
    const scarce = await variant(6000n, { stock: 1 });
    const cart = {
      lines: [
        { variantId: plenty.id, quantity: 2 },
        { variantId: scarce.id, quantity: 2 },
      ],
    };
    const short = await checkout(cart);
    const before = await footprint();
    const error = await orders.place(short).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).variantIds).toEqual([scarce.id]);
    expect(await footprint()).toEqual(before);
    expect([await stockOf(plenty.id), await stockOf(scarce.id)]).toEqual([9, 1]);
    // A variant switched off after the quote is not sold, even with stock on the shelf.
    const off = await checkout({ lines: [{ variantId: plenty.id, quantity: 1 }] });
    await pool.query("UPDATE variants SET active=false, version=version+1 WHERE id=$1", [
      plenty.id,
    ]);
    await expect(orders.place(off)).rejects.toBeInstanceOf(VariantUnavailableError);
    expect(await footprint()).toEqual(before);
    expect(await stockOf(plenty.id)).toBe(9);
  });
  it("ties every sale movement to exactly one order line in the database", async () => {
    const item = await variant(8000n, { stock: 5 });
    const placed = await orders.place(
      await checkout({ lines: [{ variantId: item.id, quantity: 1 }] }),
    );
    const orderId = placed.orderId!;
    const insert = (columns: string, values: string, params: unknown[]) =>
      pool.query(`INSERT INTO stock_movements (${columns}) VALUES (${values})`, params);
    // A sale needs its order; nothing else may point at an order; a sale removes stock.
    await expect(
      insert(
        "variant_id, delta, balance_after, reason, command_id, effect",
        "$1,-1,3,'SALE',$2,'sale'",
        [item.id, "order:" + orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        "variant_id, delta, balance_after, reason, command_id, effect, order_id",
        "$1,1,5,'RESTOCK',$2,'adjust',$3",
        [item.id, randomUUID(), orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        "variant_id, delta, balance_after, reason, command_id, effect, order_id",
        "$1,1,5,'SALE',$2,'sale',$3",
        [item.id, "order:" + orderId, orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        "variant_id, delta, balance_after, reason, command_id, effect, order_id",
        "$1,-1,3,'SALE',$2,'sale',$3",
        [item.id, "order:" + randomUUID(), orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // The same order cannot sell the same variant twice.
    await expect(
      insert(
        "variant_id, delta, balance_after, reason, command_id, effect, order_id",
        "$1,-1,3,'SALE',$2,'sale',$3",
        [item.id, "order:" + orderId, orderId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await stockOf(item.id)).toBe(4);
    // Staff reading the variant's ledger see the sale next to their own entries.
    const ledger = await listStockMovements(db, staffId, item.id, {});
    expect(
      ledger.movements.map((row) => [row.reason, row.delta, row.balanceAfter, row.actor]),
    ).toEqual([
      ["SALE", -1, 4, null],
      ["INITIAL_STOCK", 5, 5, null],
    ]);
  });
  it("does not deadlock when orders list shared variants in opposite order while stock is adjusted", async () => {
    const first = await variant(5000n, { stock: 60 });
    const second = await variant(6000n, { stock: 60 });
    await coupon("ORDERMIX");
    const cart = (reverse: boolean) => {
      const lines = [
        { variantId: first.id, quantity: 1 },
        { variantId: second.id, quantity: 2 },
      ];
      return { lines: reverse ? lines.reverse() : lines, couponCode: "ORDERMIX" };
    };
    const attempts = await Promise.all(
      Array.from({ length: 16 }, (_, n) => checkout(cart(n % 2 === 1))),
    );
    const restocks = Array.from({ length: 6 }, (_, n) =>
      adjustStock(db, { actorId: staffId, requestId: randomUUID() }, n % 2 ? first.id : second.id, {
        commandId: randomUUID(),
        delta: 1,
        reason: "RESTOCK",
      }),
    );
    const results = await Promise.allSettled([
      ...attempts.map((attempt) => orders.place(attempt)),
      ...restocks,
    ]);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result) => String((result as PromiseRejectedResult).reason)),
    ).toEqual([]);
    // 16 orders took 16 and 32; three restocks each added 3.
    expect([await stockOf(first.id), await stockOf(second.id)]).toEqual([47, 31]);
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "ORDERMIX" } })).activeRedemptions,
    ).toBe(16);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
    expect(await couponCountMismatches(db)).toEqual([]);
  });
  it("rolls everything back when a late step fails", async () => {
    const item = await variant(8000n, { stock: 5 });
    await coupon("ORDERROLL", { usageLimit: 5 });
    const placing = await checkout({
      lines: [{ variantId: item.id, quantity: 2 }],
      couponCode: "ORDERROLL",
    });
    const before = await footprint();
    // The very last write of the transaction fails: the outbox refuses the event.
    await pool.query(
      `CREATE FUNCTION synthetic_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.event_type = 'order.created' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF;
         RETURN NEW;
       END $$`,
    );
    await pool.query(
      "CREATE TRIGGER synthetic_outbox_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION synthetic_outbox_failure()",
    );
    try {
      await expect(orders.place(placing)).rejects.toThrow(/synthetic outbox failure/);
    } finally {
      await pool.query("DROP TRIGGER synthetic_outbox_failure ON outbox_events");
      await pool.query("DROP FUNCTION synthetic_outbox_failure()");
    }
    // Nothing of it exists: no order number was kept, no stock moved, no coupon use counted.
    expect(await footprint()).toEqual(before);
    expect(await stockOf(item.id)).toBe(5);
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { code: "ORDERROLL" } })).activeRedemptions,
    ).toBe(0);
    // The same attempt then succeeds.
    const placed = await orders.place(placing);
    expect(placed.replayed).toBe(false);
    expect(await stockOf(item.id)).toBe(3);
  });
  it("never makes a second order from an old key, even after its answer was cleaned up", async () => {
    const item = await variant(8000n, { stock: 5 });
    const placing = await checkout({ lines: [{ variantId: item.id, quantity: 1 }] });
    const placed = await orders.place(placing);
    // A day later the stored answer is gone.
    await pool.query(
      "ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_records_guard; ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_cookie_guard",
    );
    await pool.query(
      "UPDATE idempotency_records SET created_at=created_at-interval '2 days', expires_at=expires_at-interval '2 days', replay_cookie_expires_at=replay_cookie_expires_at-interval '2 days' WHERE resource_id=$1",
      [placed.orderId],
    );
    await pool.query(
      "ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_records_guard; ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_cookie_guard",
    );
    const expired = await orders.place(placing).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(IdempotencyExpiredError);
    expect(expired).toMatchObject({
      code: "CHECKOUT_RECOVERY_REQUIRED",
      resourceId: placed.orderId,
    });
    expect(await deleteExpiredIdempotencyRecords(db)).toBeGreaterThanOrEqual(1);
    const before = await footprint();
    const afterCleanup = await orders.place(placing).catch((error: unknown) => error);
    expect(afterCleanup).toBeInstanceOf(IdempotencyExpiredError);
    expect(afterCleanup).toMatchObject({ resourceType: "order", resourceId: placed.orderId });
    expect(await footprint()).toEqual(before);
    expect(await stockOf(item.id)).toBe(4);
  });
  it("keeps one customer for a phone, renames it, and leaves earlier orders as they were", async () => {
    const item = await variant(8000n, { stock: 9 });
    const cart = { lines: [{ variantId: item.id, quantity: 1 }] };
    const number = phone();
    const place = async (name: string, unit: string) => {
      const base = await checkout(cart);
      return orders.place({
        ...base,
        contact: checkoutContactSchema.parse({ name, phone: number }),
        address: address({ unit }),
      });
    };
    const first = await place("First Name", "101");
    const second = await place("Second Name", "101");
    const third = await place("Second Name", "202");
    const rows = await db.order.findMany({
      where: { id: { in: [first.orderId!, second.orderId!, third.orderId!] } },
      orderBy: { orderNumber: "asc" },
    });
    expect(new Set(rows.map((row) => row.customerId)).size).toBe(1);
    expect(rows.map((row) => row.customerName)).toEqual([
      "First Name",
      "Second Name",
      "Second Name",
    ]);
    expect(rows.map((row) => Number(row.orderNumber))).toEqual(
      [...rows.map((row) => Number(row.orderNumber))].sort((x, y) => x - y),
    );
    const customer = await db.customer.findUniqueOrThrow({
      where: { id: rows[0]!.customerId },
      include: { addresses: true },
    });
    expect(customer.displayName).toBe("Second Name");
    // The same address is saved once; a new one is added.
    expect(customer.addresses.map((row) => row.unit).sort()).toEqual(["101", "202"]);
    // First-order time is stamped by the first order and not moved by later ones.
    expect(customer.firstOrderAt!.getTime()).toBeGreaterThanOrEqual(rows[0]!.createdAt.getTime());
    expect(customer.firstOrderAt!.getTime()).toBeLessThan(rows[1]!.createdAt.getTime());
  });
});
