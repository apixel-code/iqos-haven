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
  createDatabase,
  createPool,
  createDeliveryArea,
  updateDeliveryArea,
  writeDeliveryConfiguration,
  readDeliveryConfiguration,
  listDeliveryAreas,
  lockDeliverySelection,
  withTransaction,
  DeliveryForbiddenError,
  PrismaOutboxWriter,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import { type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";
import { createApp } from "../bootstrap";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-delivery-test",
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
async function user(active = true, roleKey = "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `staff${seq++}@iqoshaven.test`,
      name: "Test Person",
      roleId: role.id,
      active,
      passwordHash: await hasher.hash(PASSWORD),
    },
  });
}
const post = (path: string, body: unknown, ip = "198.51.100.1", origin = ADMIN, root = base) =>
  fetch(`${root}/v1/auth/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-ih-client-ip": ip },
    body: JSON.stringify(body),
  });
let ownerCookie: string;
let ownerId: string;
let staffCookie: string;
async function login(email: string, root = base) {
  const r = await post("login", { email, password: PASSWORD }, "192.0.2.1", ADMIN, root);
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (path: string, method = "GET", body?: unknown, cookie = ownerCookie, root = base) =>
  fetch(`${root}/v1/admin/delivery-areas${path}`, {
    method,
    headers: {
      cookie,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
      "x-ih-client-ip": "192.0.2.2",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const value = { flatFeeFils: 1250, etaText: "Approved synthetic ETA", freeThresholdFils: null };
const context = () => ({ actorId: ownerId, requestId: randomUUID() });
const areaInput = (code: string, active = true) => ({ code, name: "Synthetic " + code, active });
async function waitLock(query: string) {
  for (let i = 0; i < 200; i++) {
    const r = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name='ih-delivery-test' AND wait_event_type='Lock' AND query LIKE $1",
      ["%" + query + "%"],
    );
    if (r.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected database lock wait");
}
describe("delivery configuration through real API/PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user(true, "owner");
    ownerId = owner.id;
    const staff = await user();
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    ownerCookie = await login(owner.email);
    staffCookie = await login(staff.email);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("starts empty/unconfigured without prototype defaults; all routes enforce current permissions", async () => {
    const r = await call("/configuration");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ value: null, version: 0, updatedAt: null, updatedBy: null });
    expect(await (await call("")).json()).toEqual({ items: [], nextCursor: null });
    expect(await db.setting.count()).toBe(0);
    expect(await db.deliveryArea.count()).toBe(0);
    for (const [path, method, body] of [
      ["", "GET", undefined],
      ["/configuration", "GET", undefined],
      ["", "POST", areaInput("denied")],
      ["/configuration", "PATCH", { version: 0, value }],
      ["/" + randomUUID(), "PATCH", { version: 1, name: "Denied", active: true }],
    ] as const) {
      expect((await call(path, method, body, staffCookie)).status).toBe(403);
      expect((await call(path, method, body, "")).status).toBe(401);
    }
    expect((await call("?limit=101")).status).toBe(400);
    expect((await call("?after=invalid")).status).toBe(400);
    expect((await call("?unknown=true")).status).toBe(400);
    expect((await call("/configuration?limit=1")).status).toBe(400);
  });
  it("rejects floats, negative/oversized fees, free thresholds and unbounded/unknown area inputs", async () => {
    for (const v of [
      { ...value, flatFeeFils: -1 },
      { ...value, flatFeeFils: 0.5 },
      { ...value, flatFeeFils: 1000000001 },
      { ...value, flatFeeFils: "1250" },
      { ...value, etaText: " " },
      { ...value, etaText: "x".repeat(501) },
      { ...value, freeThresholdFils: 15000 },
      { ...value, zoneFee: 500 },
    ])
      expect((await call("/configuration", "PATCH", { version: 0, value: v })).status).toBe(400);
    expect((await call("/configuration", "PATCH", { version: -1, value })).status).toBe(400);
    for (const input of [
      { ...areaInput("bad"), emirate: "sharjah" },
      { ...areaInput("bad"), code: "BAD" },
      { ...areaInput("bad"), name: " " },
      { ...areaInput("bad"), name: "x".repeat(101) },
      { ...areaInput("bad"), active: "true" },
      { ...areaInput("bad"), feeFils: 100 },
    ])
      expect((await call("", "POST", input)).status).toBe(400);
    expect(
      (await call("/invalid", "PATCH", { version: 1, name: "Test", active: false })).status,
    ).toBe(400);
  });
  it("rejects selection without configuration or for missing/inactive areas", async () => {
    const area = await createDeliveryArea(db, context(), areaInput("unconfigured"));
    await expect(
      withTransaction(db, (tx) => lockDeliverySelection(tx, area.id)),
    ).rejects.toBeInstanceOf(DeliveryUnconfiguredError);
    await expect(
      withTransaction(db, (tx) => lockDeliverySelection(tx, randomUUID())),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
  });
  it("serializes initial configuration, version conflicts, no-ops and null clear with atomic private audit/outbox", async () => {
    const results = await Promise.all([
      call("/configuration", "PATCH", { version: 0, value }),
      call("/configuration", "PATCH", { version: 0, value: { ...value, flatFeeFils: 1500 } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await readDeliveryConfiguration(db, ownerId);
    expect(current.version).toBe(1);
    expect(current.value!.freeThresholdFils).toBeNull();
    expect((await call("/configuration", "PATCH", { version: 0, value })).status).toBe(409);
    expect(
      await writeDeliveryConfiguration(db, context(), { version: 1, value: current.value }),
    ).toEqual(current);
    expect(await db.auditLog.count({ where: { entityId: "delivery" } })).toBe(1);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "delivery.configuration_updated" },
      include: { effects: true },
    });
    expect(event.payload).toEqual({ key: "delivery" });
    expect(event.effects).toHaveLength(0);
    const audits = await db.auditLog.findMany({ where: { entityId: "delivery" } });
    expect(JSON.stringify(audits)).not.toContain(value.etaText);
    expect((await call("/configuration", "PATCH", { version: 1, value: null })).status).toBe(200);
    expect(await readDeliveryConfiguration(db, ownerId)).toMatchObject({ version: 2, value: null });
    expect(await db.setting.count({ where: { key: "delivery" } })).toBe(1);
    await writeDeliveryConfiguration(db, context(), { version: 2, value });
  });
  it("creates approved-input areas with immutable code, case-insensitive unique names and bounded cursor listing", async () => {
    const r = await call("", "POST", areaInput("first", false));
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const area = (await r.json()) as { id: string };
    expect(await db.deliveryArea.findUnique({ where: { id: area.id } })).toMatchObject({
      code: "first",
      emirate: "dubai",
      active: false,
      version: 1,
    });
    expect((await call("", "POST", { ...areaInput("first"), name: "Different name" })).status).toBe(
      409,
    );
    expect(
      (await call("", "POST", { ...areaInput("second"), name: "synthetic FIRST" })).status,
    ).toBe(409);
    expect(
      (
        await call("/" + area.id, "PATCH", {
          version: 1,
          name: "Changed",
          active: true,
          code: "changed",
        })
      ).status,
    ).toBe(400);
    const collision = await call("/" + area.id, "PATCH", {
      version: 1,
      name: "synthetic UNCONFIGURED",
      active: true,
    });
    expect(collision.status).toBe(409);
    expect((await db.deliveryArea.findUniqueOrThrow({ where: { id: area.id } })).version).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: area.id } })).toBe(1);
    const first = (await (await call("?limit=1")).json()) as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]!.id);
    const second = (await (await call("?limit=1&after=" + first.nextCursor)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    await expect(
      withTransaction(db, (tx) => lockDeliverySelection(tx, area.id)),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: area.id } });
    expect(event.payload).toEqual({ areaId: area.id });
  });
  it("gives one concurrent edit winner, preserves no-op metadata and denies stale/deactivated selections", async () => {
    const area = await createDeliveryArea(db, context(), areaInput("concurrent"));
    const results = await Promise.all([
      call("/" + area.id, "PATCH", { version: 1, name: "Edited A", active: false }),
      call("/" + area.id, "PATCH", { version: 1, name: "Edited B", active: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await db.deliveryArea.findUniqueOrThrow({ where: { id: area.id } });
    expect(row.version).toBe(2);
    await updateDeliveryArea(db, context(), area.id, { version: 2, name: row.name, active: false });
    expect((await db.deliveryArea.findUniqueOrThrow({ where: { id: area.id } })).updatedAt).toEqual(
      row.updatedAt,
    );
    expect(await db.auditLog.count({ where: { entityId: area.id } })).toBe(2);
    expect(
      (await call("/" + randomUUID(), "PATCH", { version: 1, name: "Missing", active: true }))
        .status,
    ).toBe(404);
    await expect(
      withTransaction(db, (tx) => lockDeliverySelection(tx, area.id)),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
  });
  it("rolls back area/config writes and audit on failed outbox or audit, including a missing configuration sentinel", async () => {
    const area = await createDeliveryArea(db, context(), areaInput("rollback"));
    const before = await readDeliveryConfiguration(db, ownerId);
    const failed = { actorId: ownerId, requestId: "" };
    await expect(createDeliveryArea(db, failed, areaInput("audit_failure"))).rejects.toThrow();
    expect(await db.deliveryArea.findUnique({ where: { code: "audit_failure" } })).toBeNull();
    const spy = vi
      .spyOn(PrismaOutboxWriter.prototype, "publish")
      .mockRejectedValue(new Error("synthetic outbox failure"));
    try {
      await expect(
        updateDeliveryArea(db, context(), area.id, {
          version: 1,
          name: "Rolled back",
          active: false,
        }),
      ).rejects.toThrow();
      await expect(
        writeDeliveryConfiguration(db, context(), {
          version: before.version,
          value: { ...value, flatFeeFils: 700 },
        }),
      ).rejects.toThrow();
      expect((await db.deliveryArea.findUniqueOrThrow({ where: { id: area.id } })).version).toBe(1);
      expect(await readDeliveryConfiguration(db, ownerId)).toEqual(before);
      expect(await db.auditLog.count({ where: { entityId: area.id } })).toBe(1);
      await db.setting.delete({ where: { key: "delivery" } });
      await expect(
        writeDeliveryConfiguration(db, context(), { version: 0, value }),
      ).rejects.toThrow();
      expect(await db.setting.findUnique({ where: { key: "delivery" } })).toBeNull();
    } finally {
      spy.mockRestore();
    }
    await writeDeliveryConfiguration(db, context(), { version: 0, value });
  });
  it("enforces DB uniqueness, Dubai-only/stable identity and strict delivery config constraints", async () => {
    const area = await db.deliveryArea.findUniqueOrThrow({ where: { code: "first" } });
    for (const [column, v] of [
      ["code", "changed"],
      ["emirate", "sharjah"],
      ["name", " "],
      ["version", 0],
      ["updated_by", randomUUID()],
    ] as const)
      await expect(
        pool.query(`UPDATE delivery_areas SET ${column}=$1 WHERE id=$2`, [v, area.id]),
      ).rejects.toThrow();
    for (const v of [
      {},
      { ...value, flatFeeFils: -1 },
      { ...value, flatFeeFils: 0.1 },
      { ...value, freeThresholdFils: 100 },
      { ...value, etaText: " " },
      { ...value, extra: true },
    ])
      await expect(
        pool.query("UPDATE settings SET value=$1::jsonb WHERE key='delivery'", [JSON.stringify(v)]),
      ).rejects.toThrow();
  });
  it("holds configuration/area shared locks through selection, then rejects an area deactivated after commit", async () => {
    const area = await createDeliveryArea(db, context(), areaInput("selection"));
    let release!: () => void;
    let selected!: () => void;
    const ready = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selection = withTransaction(db, async (tx) => {
      const snapshot = await lockDeliverySelection(tx, area.id);
      selected();
      await held;
      return snapshot;
    });
    await ready;
    const update = updateDeliveryArea(db, context(), area.id, {
      version: 1,
      name: area.name,
      active: false,
    });
    try {
      await waitLock("SELECT id FROM delivery_areas");
    } finally {
      release();
    }
    expect(await selection).toMatchObject({
      feeFils: 1250,
      areaVersion: 1,
      configurationVersion: 1,
    });
    await update;
    await expect(
      withTransaction(db, (tx) => lockDeliverySelection(tx, area.id)),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
    let unlock!: () => void;
    let signal!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const active = await createDeliveryArea(db, context(), areaInput("fee_lock"));
    const reader = withTransaction(db, async (tx) => {
      const snapshot = await lockDeliverySelection(tx, active.id);
      signal();
      await wait;
      return snapshot;
    });
    await started;
    const config = writeDeliveryConfiguration(db, context(), {
      version: 1,
      value: { ...value, flatFeeFils: 1900 },
    });
    try {
      await waitLock("SELECT key FROM settings");
    } finally {
      unlock();
    }
    expect((await reader).feeFils).toBe(1250);
    await config;
    expect((await withTransaction(db, (tx) => lockDeliverySelection(tx, active.id))).feeFils).toBe(
      1900,
    );
  });
  it("rechecks demoted actors after the Owner guard wait; repository reads/writes deny Staff", async () => {
    const actor = await user(true, "owner");
    const holder = await pool.connect();
    let pending: ReturnType<typeof createDeliveryArea> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM roles WHERE key='owner' FOR UPDATE");
      pending = createDeliveryArea(
        db,
        { actorId: actor.id, requestId: randomUUID() },
        areaInput("demoted"),
      );
      await waitLock("SELECT id FROM roles");
      await holder.query(
        "UPDATE staff_users SET role_id=(SELECT id FROM roles WHERE key='staff'),version=version+1 WHERE id=$1",
        [actor.id],
      );
      await holder.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(DeliveryForbiddenError);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending?.catch(() => {});
    }
    expect(await db.deliveryArea.findUnique({ where: { code: "demoted" } })).toBeNull();
    await expect(readDeliveryConfiguration(db, actor.id)).rejects.toBeInstanceOf(
      DeliveryForbiddenError,
    );
    await expect(listDeliveryAreas(db, actor.id, { limit: 50 })).rejects.toBeInstanceOf(
      DeliveryForbiddenError,
    );
    await expect(
      writeDeliveryConfiguration(
        db,
        { actorId: actor.id, requestId: randomUUID() },
        { version: 2, value },
      ),
    ).rejects.toBeInstanceOf(DeliveryForbiddenError);
  });
  it("fails closed when the authoritative shared write limiter is unavailable", async () => {
    const other = await createApp(
      {
        ...env,
        RATE_LIMIT_PROFILE: "replicated",
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
      { pool, database: db },
    );
    await other.listen(0, "127.0.0.1");
    try {
      expect(
        (await call("", "POST", areaInput("unavailable"), ownerCookie, await other.getUrl()))
          .status,
      ).toBe(503);
    } finally {
      await other.close();
    }
    expect(await db.deliveryArea.findUnique({ where: { code: "unavailable" } })).toBeNull();
  });
});
