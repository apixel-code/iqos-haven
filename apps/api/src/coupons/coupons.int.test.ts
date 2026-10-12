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
  createCoupon,
  CouponForbiddenError,
  lockCouponForOrder,
  previewCoupon,
  redeemCoupon,
  withTransaction,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import { type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-coupon-admin-test",
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
  fetch(`${root}/v1/admin/coupons${path}`, {
    method,
    headers: {
      cookie,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
      "x-ih-client-ip": "192.0.2.2",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let serial = 0;
const input = (changes: Record<string, unknown> = {}) => ({
  code: "syn" + String(++serial).padStart(4, "0"),
  percentBps: 1500,
  minSubtotalFils: 10000,
  startsAt: null,
  expiresAt: null,
  active: true,
  usageLimit: 5,
  ...changes,
});
const terms = (changes: Record<string, unknown> = {}) => {
  const { code: _code, ...rest } = input(changes);
  return rest;
};
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const conflict = async (response: Response) => {
  expect(response.status).toBe(409);
  return ((await response.json()) as { error: { code: string } }).error.code;
};
const created = async (changes: Record<string, unknown> = {}) => {
  const response = await call("", "POST", input(changes));
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; code: string; version: number };
};
describe("Owner coupon administration through the real API and PostgreSQL", () => {
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
  it("starts empty and is closed to Staff and to signed-out callers", async () => {
    const list = await call("");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ items: [], nextCursor: null });
    const id = randomUUID();
    for (const [path, method, body] of [
      ["", "GET", undefined],
      ["", "POST", input()],
      ["/" + id, "PATCH", { version: 1, ...terms() }],
      ["/" + id + "/trash", "POST", { version: 1 }],
      ["/" + id + "/restore", "POST", { version: 1 }],
    ] as const) {
      expect((await call(path, method, body, staffCookie)).status).toBe(403);
      expect((await call(path, method, body, "")).status).toBe(401);
    }
    await expect(
      createCoupon(db, { actorId: null, requestId: randomUUID() }, input()),
    ).rejects.toBeInstanceOf(CouponForbiddenError);
    expect(await db.coupon.count()).toBe(0);
  });
  it("creates a percentage coupon with an audit entry and one event", async () => {
    const response = await call("", "POST", input({ code: " welcome15 " }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const coupon = await json(response);
    expect(coupon).toMatchObject({
      code: "WELCOME15",
      percentBps: 1500,
      minSubtotalFils: 10000,
      startsAt: null,
      expiresAt: null,
      active: true,
      usageLimit: 5,
      activeRedemptions: 0,
      status: "live",
      version: 1,
      trashedAt: null,
      updatedBy: ownerId,
    });
    const audit = await pool.query(
      "SELECT action, actor_id, diff FROM audit_log WHERE entity_type='coupon' AND entity_id=$1",
      [coupon.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "coupon.updated", actor_id: ownerId });
    expect(JSON.stringify(audit.rows[0].diff)).toContain("WELCOME15");
    const events = await pool.query(
      "SELECT event_type, aggregate_version::int AS aggregate_version, payload FROM outbox_events WHERE aggregate_type='coupon' AND aggregate_id=$1",
      [coupon.id],
    );
    expect(events.rows).toEqual([
      { event_type: "coupon.updated", aggregate_version: 1, payload: { couponId: coupon.id } },
    ]);
    // The code is unique in any case, and for ever.
    expect(await conflict(await call("", "POST", input({ code: "Welcome15" })))).toBe("DUPLICATE");
    expect(await db.coupon.count()).toBe(1);
  });
  it("refuses anything that is not a bounded percentage coupon", async () => {
    const before = await db.coupon.count();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    for (const bad of [
      input({ code: "ab" }),
      input({ code: "two codes" }),
      input({ percentBps: 0 }),
      input({ percentBps: 10001 }),
      input({ percentBps: 12.5 }),
      input({ percentBps: "1500" }),
      input({ minSubtotalFils: -1 }),
      input({ minSubtotalFils: 99.5 }),
      input({ usageLimit: 0 }),
      input({ startsAt: "tomorrow" }),
      input({ startsAt: future, expiresAt: future }),
      input({ startsAt: future, expiresAt: new Date().toISOString() }),
      input({ active: "yes" }),
      // No fixed-amount or scoped coupons, and no way to preset the use count.
      input({ amountFils: 2000 }),
      input({ brandId: randomUUID() }),
      input({ type: "fixed" }),
      input({ activeRedemptions: 3 }),
      (({ percentBps: _percent, ...rest }) => rest)(input()),
    ])
      expect((await call("", "POST", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await db.coupon.count()).toBe(before);
    // An active coupon that already ended is refused by the server clock.
    const ended = new Date(Date.now() - 60_000).toISOString();
    expect(await conflict(await call("", "POST", input({ expiresAt: ended })))).toBe(
      "ALREADY_EXPIRED",
    );
    expect((await call("", "POST", input({ expiresAt: ended, active: false }))).status).toBe(201);
    expect(await db.coupon.count()).toBe(before + 1);
    // A coupon that ran out on its own can still be edited, but not given another past end.
    const lapsed = await created({ minSubtotalFils: 0 });
    await pool.query(
      "UPDATE coupons SET expires_at=statement_timestamp()-interval '1 minute' WHERE id=$1",
      [lapsed.id],
    );
    const current = await db.coupon.findUniqueOrThrow({ where: { id: lapsed.id } });
    const lapsedTerms = terms({
      minSubtotalFils: 0,
      expiresAt: current.expiresAt!.toISOString(),
      usageLimit: 9,
    });
    const raised = await call("/" + lapsed.id, "PATCH", { version: 1, ...lapsedTerms });
    expect(await json(raised)).toMatchObject({ usageLimit: 9, status: "expired", version: 2 });
    expect(
      await conflict(
        await call("/" + lapsed.id, "PATCH", {
          version: 2,
          ...lapsedTerms,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toBe("ALREADY_EXPIRED");
    expect((await call("?limit=0")).status).toBe(400);
    expect((await call("?after=nope")).status).toBe(400);
    expect((await call("/not-an-id", "PATCH", { version: 1, ...terms() })).status).toBe(400);
  });
  it("edits against the version seen and records each change once", async () => {
    const coupon = await created();
    const path = "/" + coupon.id;
    const starts = new Date(Date.now() + 3_600_000).toISOString();
    const expires = new Date(Date.now() + 7_200_000).toISOString();
    const edit = await call(path, "PATCH", {
      version: 1,
      ...terms({ percentBps: 2000, startsAt: starts, expiresAt: expires, usageLimit: null }),
    });
    expect(edit.status).toBe(200);
    expect(await json(edit)).toMatchObject({
      percentBps: 2000,
      startsAt: starts,
      expiresAt: expires,
      usageLimit: null,
      status: "scheduled",
      version: 2,
    });
    // A stale version changes nothing.
    expect(
      await conflict(await call(path, "PATCH", { version: 1, ...terms({ percentBps: 9000 }) })),
    ).toBe("VERSION_CONFLICT");
    // Saving the same values again is not a change.
    const same = await call(path, "PATCH", {
      version: 2,
      ...terms({ percentBps: 2000, startsAt: starts, expiresAt: expires, usageLimit: null }),
    });
    expect(await json(same)).toMatchObject({ version: 2 });
    // The code cannot be edited.
    expect((await call(path, "PATCH", { version: 2, code: "RENAMED", ...terms() })).status).toBe(
      400,
    );
    expect((await call("/" + randomUUID(), "PATCH", { version: 1, ...terms() })).status).toBe(404);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).toMatchObject({
      code: coupon.code,
      percentBps: 2000,
      version: 2,
    });
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE entity_type='coupon' AND entity_id=$1",
      [coupon.id],
    );
    const events = await pool.query(
      "SELECT aggregate_version::int AS aggregate_version FROM outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version",
      [coupon.id],
    );
    expect(audit.rows[0].n).toBe(2);
    expect(events.rows.map((row) => row.aggregate_version)).toEqual([1, 2]);
  });
  it("does not let the limit drop below the uses orders hold", async () => {
    const coupon = await created({ usageLimit: 3, minSubtotalFils: 0 });
    for (let n = 0; n < 2; n++)
      await withTransaction(db, async (tx) => {
        const applied = await lockCouponForOrder(tx, coupon.code, 5000);
        await redeemCoupon(tx, randomUUID(), applied);
      });
    const path = "/" + coupon.id;
    expect(
      await conflict(
        await call(path, "PATCH", { version: 1, ...terms({ usageLimit: 1, minSubtotalFils: 0 }) }),
      ),
    ).toBe("LIMIT_BELOW_USES");
    const lowered = await call(path, "PATCH", {
      version: 1,
      ...terms({ usageLimit: 2, minSubtotalFils: 0 }),
    });
    expect(await json(lowered)).toMatchObject({
      usageLimit: 2,
      activeRedemptions: 2,
      status: "used_up",
      version: 2,
    });
    // The use count is not something the Owner can send.
    expect(
      (await call(path, "PATCH", { version: 2, ...terms(), activeRedemptions: 0 })).status,
    ).toBe(400);
    expect(
      (await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).activeRedemptions,
    ).toBe(2);
  });
  it("trashes and restores instead of deleting, and a trashed coupon cannot be used", async () => {
    const coupon = await created({ minSubtotalFils: 0 });
    expect((await previewCoupon(db, coupon.code, 5000)).discountFils).toBe(750);
    const path = "/" + coupon.id;
    expect(await conflict(await call(path + "/restore", "POST", { version: 1 }))).toBe(
      "NOT_TRASHED",
    );
    expect(await conflict(await call(path + "/trash", "POST", { version: 9 }))).toBe(
      "VERSION_CONFLICT",
    );
    const trashed = await json(await call(path + "/trash", "POST", { version: 1 }));
    expect(trashed).toMatchObject({ active: false, status: "trashed", version: 2 });
    expect(trashed.trashedAt).toEqual(expect.any(String));
    await expect(previewCoupon(db, coupon.code, 5000)).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    expect(await conflict(await call(path + "/trash", "POST", { version: 2 }))).toBe("TRASHED");
    expect(
      await conflict(await call(path, "PATCH", { version: 2, ...terms({ active: true }) })),
    ).toBe("TRASHED");
    // Listed only under Trash, and its code stays taken.
    const live = (await json(await call(""))) as { items: Array<{ id: string }> };
    expect(live.items.map((item) => item.id)).not.toContain(coupon.id);
    const bin = (await json(await call("?trashed=true"))) as { items: Array<{ id: string }> };
    expect(bin.items.map((item) => item.id)).toEqual([coupon.id]);
    expect(await conflict(await call("", "POST", input({ code: coupon.code })))).toBe("DUPLICATE");
    // The database itself refuses an active coupon in Trash.
    await expect(
      pool.query("UPDATE coupons SET active=true WHERE id=$1", [coupon.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const restored = await json(await call(path + "/restore", "POST", { version: 2 }));
    expect(restored).toMatchObject({
      active: false,
      status: "inactive",
      trashedAt: null,
      version: 3,
    });
    expect(await db.coupon.count({ where: { id: coupon.id } })).toBe(1);
    // There is no delete route.
    expect((await call(path, "DELETE", undefined)).status).toBeGreaterThanOrEqual(400);
    expect(await db.coupon.count({ where: { id: coupon.id } })).toBe(1);
  });
  it("pages newest first with a bounded cursor", async () => {
    const first = (await json(await call("?limit=2"))) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]!.id);
    const second = (await json(await call("?limit=2&after=" + first.nextCursor))) as {
      items: Array<{ id: string }>;
    };
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect((await call("?limit=101")).status).toBe(400);
  });
});
