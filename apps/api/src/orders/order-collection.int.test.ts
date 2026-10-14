import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import {
  adminOrderResponseSchema,
  errorEnvelopeSchema,
  orderCollectionResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
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
  applicationName: "ih-order-collection-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
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
type Seeded = Awaited<ReturnType<typeof seedOrder>>;

const send = (path: string, method: string, body: unknown, cookie: string, origin = ADMIN) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      // Each call from its own address keeps the per-address limiter out of the way.
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const order = async (orderId: string) =>
  one<{
    status: string;
    version: number;
    cod: string;
    reason: string | null;
    returned: Date | null;
  }>(
    "SELECT status, version, cod_status AS cod, cancel_reason AS reason, returned_at AS returned FROM orders WHERE id=$1",
    [orderId],
  );
const count = async (sql: string, params: unknown[]) =>
  Number((await one<{ n: string }>(sql, params)).n);
const detail = async (orderId: string) =>
  adminOrderResponseSchema.parse(await (await send(`/${orderId}`, "GET", null, owner)).json());

/** A seeded order whose variant is sellable and holds `stock` units on the ledger. */
async function sellable(seeded: Seeded, stock = 20) {
  for (const sql of [
    `UPDATE brands SET active=true WHERE id=(SELECT p.brand_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    `UPDATE categories SET active=true WHERE id=(SELECT p.category_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    "UPDATE products SET status='published' WHERE id=(SELECT product_id FROM variants WHERE id=$1)",
  ])
    await pool.query(sql, [seeded.variantId]);
  await pool.query(
    "UPDATE delivery_areas SET active=true WHERE id=(SELECT area_id FROM orders WHERE id=$1)",
    [seeded.orderId],
  );
  await pool.query(
    `INSERT INTO stock_movements (variant_id,delta,balance_after,reason,command_id,effect,actor_id)
     VALUES ($1,$2,$2,'INITIAL_STOCK',$3,'adjust',$4)`,
    [seeded.variantId, stock, `stock-${seeded.variantId}`, ownerId],
  );
  return seeded;
}
async function moveTo(orderId: string, targets: string[]) {
  for (const to of targets) {
    const { version } = await order(orderId);
    const response = await send(
      `/${orderId}/transitions`,
      "POST",
      { to, expectedVersion: version, commandId: randomUUID() },
      owner,
    );
    expect(response.status).toBe(200);
  }
}

describe("cash-on-delivery collection through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "Cash Owner" : "Cash Staff",
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
    const o = await login("owner", "cash-owner@iqoshaven.test");
    const s = await login("staff", "cash-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
    await db.setting.create({
      data: {
        key: "delivery",
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
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

  const collect = (orderId: string, body: unknown, cookie = staff, origin = ADMIN) =>
    send(`/${orderId}/collection`, "POST", body, cookie, origin);
  const correct = (orderId: string, body: unknown, cookie = owner) =>
    send(`/${orderId}/collection/corrections`, "POST", body, cookie);
  /** A delivered order with cash pending: AED 65.00 (one seeded unit and delivery). */
  async function delivered(quantity = 1) {
    const seeded = await sellable(await seedOrder(pool, { status: "confirmed", quantity }));
    await moveTo(seeded.orderId, ["processing", "out_for_delivery", "delivered"]);
    return seeded;
  }
  const record = (version: number, extra: Record<string, unknown> = {}) => ({
    expectedVersion: version,
    commandId: randomUUID(),
    amountFils: 6500,
    reference: "Courier slip 1",
    ...extra,
  });
  const cash = (orderId: string) =>
    one<{
      cod: string;
      amount: string | null;
      at: Date | null;
      by: string | null;
      ref: string | null;
      version: number;
    }>(
      "SELECT cod_status AS cod, collected_amount_fils AS amount, collected_at AS at, collected_by AS by, collection_reference AS ref, version FROM orders WHERE id=$1",
      [orderId],
    );

  it("never records cash on delivery by itself, and records it once on command", async () => {
    const target = await delivered();
    // Delivered is not collected.
    expect(await cash(target.orderId)).toMatchObject({ cod: "pending", amount: null, at: null });
    const body = record(4);
    const response = await collect(target.orderId, body);
    expect(response.status).toBe(200);
    const receipt = orderCollectionResponseSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      orderId: target.orderId,
      kind: "recorded",
      orderVersion: 5,
      amountFils: 6500,
      reference: "Courier slip 1",
      reason: null,
      actor: { name: "Cash Staff" },
      replayed: false,
    });
    const after = await cash(target.orderId);
    expect(after).toMatchObject({
      cod: "collected",
      amount: "6500",
      ref: "Courier slip 1",
      version: 5,
    });
    expect(after.at!.toISOString()).toBe(receipt.collectedAt);
    // Retry: the same answer; another command is refused, as is collecting twice.
    const again = await collect(target.orderId, body);
    expect(orderCollectionResponseSchema.parse(await again.json())).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(await errorCode(await collect(target.orderId, { ...body, amountFils: 1 }))).toBe(
      "COMMAND_REUSED",
    );
    expect(await errorCode(await collect(target.orderId, record(5)))).toBe(
      "COLLECTION_NOT_ALLOWED",
    );
    expect(
      await count("SELECT count(*) AS n FROM order_collection_records WHERE order_id=$1", [
        target.orderId,
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE entity_id=$1 AND action='order.collection_recorded'",
        [target.orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.collection_recorded'",
        [target.orderId],
      ),
    ).toBe(1);
  });

  it("refuses cash for an order that is not delivered, a bad time, a stale version or no right", async () => {
    const pending = await sellable(await seedOrder(pool));
    expect(await errorCode(await collect(pending.orderId, record(1)))).toBe(
      "COLLECTION_NOT_ALLOWED",
    );
    const outForDelivery = await sellable(await seedOrder(pool, { status: "confirmed" }));
    await moveTo(outForDelivery.orderId, ["processing", "out_for_delivery"]);
    expect(await errorCode(await collect(outForDelivery.orderId, record(3)))).toBe(
      "COLLECTION_NOT_ALLOWED",
    );
    const cancelled = await sellable(await seedOrder(pool));
    expect(
      (
        await send(
          `/${cancelled.orderId}/cancel`,
          "POST",
          { expectedVersion: 1, commandId: randomUUID(), reason: "No" },
          staff,
        )
      ).status,
    ).toBe(200);
    expect(await errorCode(await collect(cancelled.orderId, record(2)))).toBe(
      "COLLECTION_NOT_ALLOWED",
    );

    const target = await delivered();
    expect(await errorCode(await collect(target.orderId, record(3)))).toBe("VERSION_CONFLICT");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await collect(target.orderId, record(4, { collectedAt: future }))).status).toBe(400);
    expect(
      (await collect(target.orderId, record(4, { collectedAt: "2020-01-01T00:00:00Z" }))).status,
    ).toBe(400);
    for (const extra of [
      { amountFils: -1 },
      { amountFils: 10.5 },
      { reference: "" },
      { totalFils: 1 },
    ])
      expect((await collect(target.orderId, record(4, extra))).status).toBe(400);
    expect((await collect(target.orderId, record(4), staff, "https://evil.example")).status).toBe(
      403,
    );
    await pool.query(
      `DELETE FROM role_permissions rp USING permissions p
       WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='orders.collect'`,
      [staffRoleId],
    );
    try {
      expect((await collect(target.orderId, record(4))).status).toBe(403);
    } finally {
      await pool.query(
        "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key='orders.collect'",
        [staffRoleId],
      );
    }
    expect(await cash(target.orderId)).toMatchObject({ cod: "pending", version: 4 });
    // A delivered, collected order cannot be cancelled.
    expect((await collect(target.orderId, record(4))).status).toBe(200);
    expect(
      await errorCode(
        await send(
          `/${target.orderId}/cancel`,
          "POST",
          { expectedVersion: 5, commandId: randomUUID(), reason: "No" },
          owner,
        ),
      ),
    ).toBe("ORDER_NOT_CANCELLABLE");
  });

  it("records a given collection time, and one collection when two are sent at once", async () => {
    const target = await delivered();
    // Entered to the minute, in the minute it was delivered.
    const { at } = await one<{ at: Date }>(
      "SELECT date_trunc('minute', delivered_at) AS at FROM orders WHERE id=$1",
      [target.orderId],
    );
    const answers = await Promise.all([
      collect(target.orderId, record(4, { collectedAt: at.toISOString() })),
      collect(
        target.orderId,
        record(4, { collectedAt: at.toISOString(), amountFils: 6000 }),
        owner,
      ),
    ]);
    expect(answers.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      await count("SELECT count(*) AS n FROM order_collection_records WHERE order_id=$1", [
        target.orderId,
      ]),
    ).toBe(1);
    expect((await cash(target.orderId)).at!.toISOString()).toBe(at.toISOString());
  });

  it("lets only the Owner correct, with a reason, keeping the original evidence", async () => {
    const target = await delivered();
    expect((await collect(target.orderId, record(4, { amountFils: 6000 }))).status).toBe(200);
    const original = await cash(target.orderId);
    const fix = {
      expectedVersion: 5,
      commandId: randomUUID(),
      reason: "Courier handed over AED 65.00, not 60.00",
      amountFils: 6500,
      reference: "Courier slip 1",
      collectedAt: original.at!.toISOString(),
    };
    // Staff may not correct; nothing to correct on a pending order; a correction needs a reason.
    expect((await correct(target.orderId, fix, staff)).status).toBe(403);
    const other = await delivered();
    expect(await errorCode(await correct(other.orderId, { ...fix, expectedVersion: 4 }))).toBe(
      "NOT_COLLECTED",
    );
    expect((await correct(target.orderId, { ...fix, reason: " " })).status).toBe(400);
    expect(
      await errorCode(
        await correct(target.orderId, { ...fix, amountFils: 6000, commandId: randomUUID() }),
      ),
    ).toBe("NO_CHANGES");

    const response = await correct(target.orderId, fix);
    expect(response.status).toBe(200);
    const receipt = orderCollectionResponseSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      kind: "corrected",
      orderVersion: 6,
      amountFils: 6500,
      reason: "Courier handed over AED 65.00, not 60.00",
      actor: { name: "Cash Owner" },
    });
    // The original record on the order is untouched.
    expect(await cash(target.orderId)).toMatchObject({
      cod: "collected",
      amount: "6000",
      ref: original.ref,
      by: original.by,
      version: 6,
    });
    expect((await cash(target.orderId)).at!.toISOString()).toBe(original.at!.toISOString());
    const again = await correct(target.orderId, fix);
    expect(orderCollectionResponseSchema.parse(await again.json())).toEqual({
      ...receipt,
      replayed: true,
    });
    // The detail lists both, oldest first; the last is in effect.
    const shown = await detail(target.orderId);
    expect(shown.collectionRecords.map((entry) => [entry.kind, entry.amountFils])).toEqual([
      ["recorded", 6000],
      ["corrected", 6500],
    ]);
    expect(shown.collectedAmountFils).toBe(6000);
    // The audit keeps the reason with the before and after amounts.
    const audit = await one<{ diff: { before: unknown; after: unknown }; reason: string }>(
      "SELECT diff, reason FROM audit_log WHERE entity_id=$1 AND action='order.collection_corrected'",
      [target.orderId],
    );
    expect(audit.reason).toBe("Courier handed over AED 65.00, not 60.00");
    expect(JSON.stringify(audit.diff)).toContain("6000");
    expect(JSON.stringify(audit.diff)).toContain("6500");
  });

  it("corrects again later, keeps the exact time when only the reference changes, and replays", async () => {
    const target = await delivered();
    expect((await collect(target.orderId, record(4))).status).toBe(200);
    const shown = await detail(target.orderId);
    const first = shown.collectionRecords[0]!;
    const change = (version: number, extra: Record<string, unknown>) => ({
      expectedVersion: version,
      commandId: randomUUID(),
      reason: "Slip number was mistyped",
      amountFils: first.amountFils,
      reference: first.reference,
      collectedAt: first.collectedAt,
      ...extra,
    });
    // Nothing differs from the record in effect.
    expect(await errorCode(await correct(target.orderId, change(5, {})))).toBe("NO_CHANGES");
    const onlyReference = change(5, { reference: "Courier slip 7" });
    const firstFix = orderCollectionResponseSchema.parse(
      await (await correct(target.orderId, onlyReference)).json(),
    );
    expect(firstFix).toMatchObject({ reference: "Courier slip 7", amountFils: 6500 });
    expect(firstFix.collectedAt).toBe(first.collectedAt);
    // Same ID, different correction: refused; another Owner replaying it: refused too.
    expect(
      await errorCode(await correct(target.orderId, { ...onlyReference, reference: "Other" })),
    ).toBe("COMMAND_REUSED");
    const secondFix = change(6, {
      amountFils: 6400,
      reference: "Courier slip 7",
      reason: "Short by AED 1",
    });
    expect((await correct(target.orderId, secondFix)).status).toBe(200);
    const latest = await detail(target.orderId);
    expect(
      latest.collectionRecords.map((entry) => [entry.kind, entry.amountFils, entry.reference]),
    ).toEqual([
      ["recorded", 6500, "Courier slip 1"],
      ["corrected", 6500, "Courier slip 7"],
      ["corrected", 6400, "Courier slip 7"],
    ]);
    // The original evidence on the order is still the first record.
    expect(latest).toMatchObject({
      collectedAmountFils: 6500,
      collectionReference: "Courier slip 1",
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.collection_corrected'",
        [target.orderId],
      ),
    ).toBe(2);
  });

  it("keeps the evidence unchangeable", async () => {
    const target = await delivered();
    expect((await collect(target.orderId, record(4))).status).toBe(200);
    for (const sql of [
      "UPDATE order_collection_records SET amount_fils=1 WHERE order_id=$1",
      "DELETE FROM order_collection_records WHERE order_id=$1",
      "UPDATE orders SET collected_amount_fils=1, version=version+1 WHERE id=$1",
      "UPDATE orders SET cod_status='pending', collected_amount_fils=NULL, collected_at=NULL, collected_by=NULL, collection_reference=NULL, version=version+1 WHERE id=$1",
    ])
      await expect(pool.query(sql, [target.orderId])).rejects.toThrow();
  });
});
