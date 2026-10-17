import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { InventoryItem, StockAdjustmentResponse, StockMovement } from "@ih/contracts";
import {
  adjustStock,
  setStock,
  createDatabase,
  createPool,
  stockReconciliationMismatches,
  CatalogueConflictError,
} from "@ih/db";
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
  applicationName: "ih-inventory-test",
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
let base: string;
let seq = 0;
let ownerId = "";
let productId = "";
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `inventory${seq++}@iqoshaven.test`,
      name: "Stock Person",
      roleId: role.id,
      passwordHash: await hasher.hash(PASSWORD),
    },
  });
}
async function login(email: string) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (path: string, method = "GET", body?: unknown, cookie = cookies.staff) =>
  fetch(`${base}/v1/admin/inventory${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const adjust = async (variantId: string, body: Record<string, unknown>, cookie = cookies.staff) =>
  call(`/${variantId}/adjustments`, "POST", { commandId: randomUUID(), ...body }, cookie);
async function variant(threshold = 5) {
  return db.variant.create({
    data: {
      productId,
      sku: "INV-" + randomUUID().slice(0, 8).toUpperCase(),
      attributes: {},
      lowStockThreshold: threshold,
      active: true,
    },
  });
}

describe("stock ledger and inventory through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    ownerId = owner.id;
    const staff = await user("staff");
    const brand = await db.brand.create({ data: { name: "Stock brand", slug: "stock-brand" } });
    const category = await db.category.create({
      data: { name: "Stock category", slug: "stock-category" },
    });
    productId = (
      await db.product.create({
        data: {
          name: "Stock product",
          slug: "stock-product",
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
    cookies.owner = await login(owner.email);
    cookies.staff = await login(staff.email);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  // Each variant needs a distinct option signature within the product.
  let colour = 0;
  async function freshVariant(threshold = 5) {
    const row = await variant(threshold);
    await pool.query("UPDATE variants SET attributes=$1::jsonb WHERE id=$2", [
      JSON.stringify({ colour: "c" + colour++ }),
      row.id,
    ]);
    return row;
  }

  it("records initial stock, restock, damage and manual movements with exact balances", async () => {
    const v = await freshVariant();
    const steps: Array<[Record<string, unknown>, number]> = [
      [{ reason: "INITIAL_STOCK", delta: 20 }, 20],
      [{ reason: "RESTOCK", delta: 5 }, 25],
      [{ reason: "DAMAGE", delta: -3, note: "Crushed in delivery" }, 22],
      [{ reason: "MANUAL", delta: -2, note: "Count correction" }, 20],
    ];
    for (const [body, balance] of steps) {
      const response = await adjust(v.id, body);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = (await response.json()) as StockAdjustmentResponse;
      expect(result.movement.balanceAfter).toBe(balance);
      expect(result.item.stockOnHand).toBe(balance);
      expect(result.replayed).toBe(false);
    }
    const history = (await (await call(`/${v.id}/movements`)).json()) as {
      item: InventoryItem;
      movements: StockMovement[];
    };
    expect(history.movements.map((m) => [m.reason, m.delta, m.balanceAfter])).toEqual([
      ["MANUAL", -2, 20],
      ["DAMAGE", -3, 22],
      ["RESTOCK", 5, 25],
      ["INITIAL_STOCK", 20, 20],
    ]);
    expect(history.movements[0]!.actor?.name).toBe("Stock Person");
    const audit = await db.auditLog.findMany({ where: { entityId: v.id } });
    expect(audit).toHaveLength(4);
    expect(JSON.stringify(audit.map((a) => a.diff))).not.toContain("Crushed");
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("never goes below zero and allows initial stock only first", async () => {
    const v = await freshVariant();
    expect(await code(await adjust(v.id, { reason: "MANUAL", delta: -1, note: "x" }))).toBe(
      "INSUFFICIENT_STOCK",
    );
    await adjust(v.id, { reason: "RESTOCK", delta: 2 });
    expect(await code(await adjust(v.id, { reason: "INITIAL_STOCK", delta: 5 }))).toBe(
      "INITIAL_STOCK_EXISTS",
    );
    expect(await code(await adjust(v.id, { reason: "DAMAGE", delta: -3, note: "x" }))).toBe(
      "INSUFFICIENT_STOCK",
    );
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(2);
    expect(await db.stockMovement.count({ where: { variantId: v.id } })).toBe(1);
  });

  it("validates reasons, signs, notes and bounds", async () => {
    const v = await freshVariant();
    for (const body of [
      { reason: "RESTOCK", delta: -1 },
      { reason: "INITIAL_STOCK", delta: -5 },
      { reason: "DAMAGE", delta: 2, note: "x" },
      { reason: "DAMAGE", delta: -1 },
      { reason: "MANUAL", delta: 3 },
      { reason: "MANUAL", delta: 0, note: "x" },
      { reason: "MANUAL", delta: 1.5, note: "x" },
      { reason: "MANUAL", delta: 1_000_001, note: "x" },
      { reason: "SALE", delta: -1 },
      { reason: "RESTOCK", delta: 1, stockOnHand: 99 },
      { reason: "RESTOCK", delta: 1, note: "a".repeat(501) },
    ])
      expect((await adjust(v.id, body)).status, JSON.stringify(body)).toBe(400);
    expect((await adjust(randomUUID(), { reason: "RESTOCK", delta: 1 })).status).toBe(404);
    expect(
      (await call(`/${v.id}/adjustments`, "POST", { reason: "RESTOCK", delta: 1 })).status,
    ).toBe(400);
  });

  it("replays the same command and rejects a reused command with a different payload", async () => {
    const v = await freshVariant();
    const commandId = randomUUID();
    const body = { commandId, reason: "RESTOCK", delta: 4 };
    const first = (await (
      await call(`/${v.id}/adjustments`, "POST", body)
    ).json()) as StockAdjustmentResponse;
    const again = (await (
      await call(`/${v.id}/adjustments`, "POST", body)
    ).json()) as StockAdjustmentResponse;
    expect(again.replayed).toBe(true);
    expect(again.movement.id).toBe(first.movement.id);
    expect(again.item.stockOnHand).toBe(4);
    expect(await code(await call(`/${v.id}/adjustments`, "POST", { ...body, delta: 5 }))).toBe(
      "COMMAND_REUSED",
    );
    // Concurrent duplicates of one command apply exactly once.
    const concurrentId = randomUUID();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        adjustStock(db, { actorId: ownerId, requestId: randomUUID() }, v.id, {
          commandId: concurrentId,
          reason: "RESTOCK",
          delta: 10,
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(14);
  });

  it("keeps balance and ledger equal under concurrent removals of the last units", async () => {
    const v = await freshVariant();
    await adjust(v.id, { reason: "INITIAL_STOCK", delta: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        adjustStock(db, { actorId: ownerId, requestId: randomUUID() }, v.id, {
          commandId: randomUUID(),
          reason: "MANUAL",
          delta: -1,
          note: "Concurrent count",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(CatalogueConflictError);
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(0);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("lists stock states, filters literally and pages by variant", async () => {
    const out = await freshVariant(5);
    const low = await freshVariant(5);
    const plenty = await freshVariant(5);
    await adjust(low.id, { reason: "INITIAL_STOCK", delta: 5 });
    await adjust(plenty.id, { reason: "INITIAL_STOCK", delta: 50 });
    const page = (await (await call(`?productId=${productId}&limit=100`)).json()) as {
      items: InventoryItem[];
    };
    const state = (id: string) => page.items.find((i) => i.variantId === id)?.stockState;
    expect([state(out.id), state(low.id), state(plenty.id)]).toEqual(["out", "low", "in_stock"]);
    const lows = (await (await call("?state=low&limit=100")).json()) as { items: InventoryItem[] };
    expect(lows.items.every((i) => i.stockState === "low")).toBe(true);
    const bySku = (await (await call("?q=" + encodeURIComponent(plenty.sku))).json()) as {
      items: InventoryItem[];
    };
    expect(bySku.items.map((i) => i.variantId)).toEqual([plenty.id]);
    // One variant, as a low-stock notification links to it (parity G-A2).
    const one = (await (await call(`?variantId=${low.id}`)).json()) as { items: InventoryItem[] };
    expect(one.items.map((i) => i.variantId)).toEqual([low.id]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next = (await (await call(`?limit=2${cursor ? "&after=" + cursor : ""}`)).json()) as {
        items: InventoryItem[];
        nextCursor: string | null;
      };
      seen.push(...next.items.map((i) => i.variantId));
      cursor = next.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    for (const bad of ["?limit=0", "?state=empty", "?after=x"])
      expect((await call(bad)).status).toBe(400);
  });

  it("replays concurrent duplicates even when the first one exhausts the stock", async () => {
    const v = await freshVariant();
    await adjust(v.id, { reason: "INITIAL_STOCK", delta: 5 });
    const commandId = randomUUID();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        adjustStock(db, { actorId: ownerId, requestId: randomUUID() }, v.id, {
          commandId,
          reason: "MANUAL",
          delta: -5,
          note: "Sold at a pop-up",
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.movement.id)).size).toBe(1);
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(0);
  });

  it("refuses a command ID reused on another variant", async () => {
    const a = await freshVariant();
    const b = await freshVariant();
    const commandId = randomUUID();
    const body = { commandId, reason: "RESTOCK", delta: 1 };
    expect((await call(`/${a.id}/adjustments`, "POST", body)).status).toBe(200);
    expect(await code(await call(`/${b.id}/adjustments`, "POST", body))).toBe("COMMAND_REUSED");
  });

  it("caps balances and allows adjusting a trashed product's physical stock", async () => {
    const v = await freshVariant();
    await adjust(v.id, { reason: "INITIAL_STOCK", delta: 1_000_000 });
    for (let i = 0; i < 99; i++) await adjust(v.id, { reason: "RESTOCK", delta: 1_000_000 });
    expect(await code(await adjust(v.id, { reason: "RESTOCK", delta: 1 }))).toBe("STOCK_LIMIT");
    const other = await freshVariant();
    await db.product.update({ where: { id: productId }, data: { deletedAt: new Date() } });
    try {
      expect((await adjust(other.id, { reason: "RESTOCK", delta: 2 })).status).toBe(200);
    } finally {
      await db.product.update({ where: { id: productId }, data: { deletedAt: null } });
    }
  });

  it("keeps the ledger and balances consistent for every insert shape", async () => {
    const v = await freshVariant();
    await adjust(v.id, { reason: "INITIAL_STOCK", delta: 4 });
    const commandId = randomUUID();
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 5, 'RESTOCK', $2)",
      [v.id, commandId],
    );
    // A duplicate skipped by ON CONFLICT never touches the balance.
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 6, 'RESTOCK', $2) ON CONFLICT DO NOTHING",
      [v.id, commandId],
    );
    // A multi-row insert with one bad row changes nothing.
    await expect(
      pool.query(
        "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 6, 'RESTOCK', $2), ($1, 1, 99, 'RESTOCK', $3)",
        [v.id, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "IH002" });
    await expect(
      pool.query(
        "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 1, 1, 'RESTOCK', 'x')",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(5);
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  const set = (variantId: string, body: Record<string, unknown>) =>
    call(`/${variantId}/set`, "POST", { commandId: randomUUID(), note: "Shelf count", ...body });

  it("sets stock from a count: initial first, then manual deltas computed under the lock", async () => {
    const v = await freshVariant();
    const first = (await (
      await set(v.id, { expectedStockOnHand: 0, targetStockOnHand: 12 })
    ).json()) as { item: InventoryItem; movement: StockMovement };
    expect(first.movement).toMatchObject({ reason: "INITIAL_STOCK", delta: 12, balanceAfter: 12 });
    const second = (await (
      await set(v.id, { expectedStockOnHand: 12, targetStockOnHand: 9 })
    ).json()) as { item: InventoryItem; movement: StockMovement };
    expect(second.movement).toMatchObject({ reason: "MANUAL", delta: -3, balanceAfter: 9 });
    expect(second.movement.note).toBe("Shelf count");
    const same = (await (
      await set(v.id, { expectedStockOnHand: 9, targetStockOnHand: 9 })
    ).json()) as { item: InventoryItem; movement: StockMovement | null };
    expect(same.movement).toBeNull();
    expect(await db.stockMovement.count({ where: { variantId: v.id } })).toBe(2);
  });

  it("refuses a set based on a stale balance with STOCK_CHANGED", async () => {
    const v = await freshVariant();
    await set(v.id, { expectedStockOnHand: 0, targetStockOnHand: 10 });
    await adjust(v.id, { reason: "MANUAL", delta: -2, note: "Sold in store" });
    expect(await code(await set(v.id, { expectedStockOnHand: 10, targetStockOnHand: 15 }))).toBe(
      "STOCK_CHANGED",
    );
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(8);
    for (const body of [
      { expectedStockOnHand: 8, targetStockOnHand: -1 },
      { expectedStockOnHand: 8, targetStockOnHand: 100_000_001 },
      { expectedStockOnHand: 8, targetStockOnHand: 5, note: "" },
      { expectedStockOnHand: 8, targetStockOnHand: 5.5 },
    ])
      expect((await set(v.id, body)).status).toBe(400);
  });

  it("concurrent sets from the same view: one wins, the rest see STOCK_CHANGED", async () => {
    const v = await freshVariant();
    await set(v.id, { expectedStockOnHand: 0, targetStockOnHand: 10 });
    const results = await Promise.allSettled(
      [4, 6, 8, 12].map((target) =>
        setStock(db, { actorId: ownerId, requestId: randomUUID() }, v.id, {
          commandId: randomUUID(),
          expectedStockOnHand: 10,
          targetStockOnHand: target,
          note: "Count",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect((r.reason as CatalogueConflictError).reason).toBe("STOCK_CHANGED");
    expect(await stockReconciliationMismatches(db)).toEqual([]);
  });

  it("replays a retried set and refuses a reused command for another target", async () => {
    const v = await freshVariant();
    await set(v.id, { expectedStockOnHand: 0, targetStockOnHand: 5 });
    const body = {
      commandId: randomUUID(),
      expectedStockOnHand: 5,
      targetStockOnHand: 7,
      note: "Recount",
    };
    const first = (await (await call(`/${v.id}/set`, "POST", body)).json()) as {
      replayed: boolean;
    };
    const again = (await (await call(`/${v.id}/set`, "POST", body)).json()) as {
      replayed: boolean;
      item: InventoryItem;
    };
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.item.stockOnHand).toBe(7);
    expect(await code(await call(`/${v.id}/set`, "POST", { ...body, targetStockOnHand: 9 }))).toBe(
      "COMMAND_REUSED",
    );
  });

  it("replays a retried first set and applies concurrent duplicates once", async () => {
    const v = await freshVariant();
    const body = {
      commandId: randomUUID(),
      expectedStockOnHand: 0,
      targetStockOnHand: 6,
      note: "Opening count",
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => setStock(db, { actorId: ownerId, requestId: randomUUID() }, v.id, body)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results[0]!.movement?.reason).toBe("INITIAL_STOCK");
    // A later retry still replays even though the balance now differs from the expected 0.
    const late = (await (await call(`/${v.id}/set`, "POST", body)).json()) as { replayed: boolean };
    expect(late.replayed).toBe(true);
    const audit = await db.auditLog.findMany({ where: { entityId: v.id } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.diff)).toContain('"set"');
    expect(JSON.stringify(audit[0]!.diff)).not.toContain("Opening count");
  });

  it("never treats a set command ID as an adjustment (or the reverse)", async () => {
    const v = await freshVariant();
    const commandId = randomUUID();
    await call(`/${v.id}/set`, "POST", {
      commandId,
      expectedStockOnHand: 0,
      targetStockOnHand: 3,
      note: "Count",
    });
    expect(
      await code(
        await call(`/${v.id}/adjustments`, "POST", {
          commandId,
          reason: "INITIAL_STOCK",
          delta: 3,
          note: "Count",
        }),
      ),
    ).toBe("COMMAND_REUSED");
  });

  it("forbids ledger tampering and direct stock writes", async () => {
    const v = await freshVariant();
    await adjust(v.id, { reason: "INITIAL_STOCK", delta: 7 });
    await expect(
      pool.query("UPDATE stock_movements SET delta=100 WHERE variant_id=$1", [v.id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      pool.query("DELETE FROM stock_movements WHERE variant_id=$1", [v.id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      pool.query("UPDATE variants SET stock_on_hand=100 WHERE id=$1", [v.id]),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(7);
  });

  it("requires inventory permissions", async () => {
    const v = await freshVariant();
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const permission = await db.permission.findUniqueOrThrow({
      where: { key: "inventory.adjust" },
    });
    const grant = { roleId: role.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect((await adjust(v.id, { reason: "RESTOCK", delta: 1 })).status).toBe(403);
      expect((await call("?limit=1")).status).toBe(200);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.id } })).stockOnHand).toBe(0);
  });
});
