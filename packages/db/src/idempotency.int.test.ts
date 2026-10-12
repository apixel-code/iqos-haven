import { randomBytes, randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import {
  canonicalPayloadHash,
  claimIdempotency,
  completeIdempotency,
  deleteExpiredIdempotencyRecords,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  IdempotencyInProgressError,
  IdempotencyKeyError,
  idempotencyKeyHash,
  isIdempotencyKey,
  runIdempotent,
} from "./idempotency";
import { applyMigrations, seedOrder } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-idempotency-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const SCOPE = "store.checkout";
const key = () => randomBytes(24).toString("base64url");
const payload = (changes: Record<string, unknown> = {}) => ({
  lines: [{ variantId: "00000000-0000-7000-8000-000000000001", quantity: 2 }],
  areaId: "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a35",
  couponCode: null,
  quoteFingerprint: "A".repeat(43),
  ...changes,
});
const request = (k: string, body: unknown = payload(), extra: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  key: k,
  payloadHash: canonicalPayloadHash(body),
  ...extra,
});
const rows = async (k: string, scope = SCOPE) =>
  (
    await pool.query("SELECT * FROM idempotency_records WHERE scope=$1 AND key_hash=$2", [
      scope,
      idempotencyKeyHash(scope, k),
    ])
  ).rows;
describe("idempotent commands (real PostgreSQL, isolated schema)", () => {
  let runtimeRole = false;
  beforeAll(async () => {
    runtimeRole =
      (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ih_app'")).rowCount === 1;
    if (process.env.CI) expect(runtimeRole).toBe(true);
    await applyMigrations(pool, namespace, runtimeRole ? { runtimeRole: "ih_app" } : {});
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("hashes a request the same way whatever order its fields come in", () => {
    const base = canonicalPayloadHash(payload());
    expect(base).toHaveLength(32);
    expect(
      canonicalPayloadHash({
        quoteFingerprint: "A".repeat(43),
        couponCode: null,
        areaId: payload().areaId,
        lines: [{ quantity: 2, variantId: "00000000-0000-7000-8000-000000000001" }],
      }).equals(base),
    ).toBe(true);
    for (const changed of [
      payload({ couponCode: "EID10" }),
      payload({ quoteFingerprint: "B".repeat(43) }),
      payload({ lines: [{ variantId: "00000000-0000-7000-8000-000000000001", quantity: 3 }] }),
      payload({ extra: true }),
    ])
      expect(canonicalPayloadHash(changed).equals(base)).toBe(false);
    // An absent value must be written as null: `undefined` and array holes are refused.
    expect(() => canonicalPayloadHash({ ...payload(), couponCode: undefined })).toThrow(TypeError);
    expect(() => canonicalPayloadHash(undefined)).toThrow(TypeError);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalPayloadHash([1, , 2])).toThrow(TypeError);
    expect(() => canonicalPayloadHash(Object.create(null))).toThrow(TypeError);
    // Array order is part of the request; "1" is not 1; floats and non-JSON are refused.
    expect(canonicalPayloadHash([1, 2]).equals(canonicalPayloadHash([2, 1]))).toBe(false);
    expect(canonicalPayloadHash({ a: "1" }).equals(canonicalPayloadHash({ a: 1 }))).toBe(false);
    for (const bad of [
      { a: 1.5 },
      { a: Number.NaN },
      { a: new Date() },
      { a: () => 1 },
      { a: 10n },
    ])
      expect(() => canonicalPayloadHash(bad)).toThrow(TypeError);
  });
  it("accepts only random-looking keys and binds the hash to the scope", () => {
    const k = key();
    expect(isIdempotencyKey(k)).toBe(true);
    expect(isIdempotencyKey(randomUUID())).toBe(true);
    for (const bad of [
      "",
      "short",
      "x".repeat(21),
      "x".repeat(129),
      "has space in the key value",
      "naïve-key-with-accent-chars-1",
      42,
      null,
    ])
      expect(isIdempotencyKey(bad), String(bad)).toBe(false);
    expect(idempotencyKeyHash(SCOPE, k).equals(idempotencyKeyHash("admin.order.cancel", k))).toBe(
      false,
    );
    expect(() => idempotencyKeyHash("Bad Scope", k)).toThrow(IdempotencyKeyError);
    expect(() => idempotencyKeyHash(SCOPE, "short")).toThrow(IdempotencyKeyError);
  });
  it("runs a command once and replays its answer for the same key and payload", async () => {
    const k = key();
    const { orderId } = await seedOrder(pool);
    let runs = 0;
    const work = async () => {
      runs++;
      return {
        response: { orderNumber: "IH-001001", totalFils: 6500 },
        resourceType: "order",
        resourceId: orderId,
      };
    };
    const first = await runIdempotent(db, request(k), work);
    expect(first).toEqual({
      replayed: false,
      response: { orderNumber: "IH-001001", totalFils: 6500 },
      resourceId: orderId,
    });
    for (let n = 0; n < 3; n++)
      expect(await runIdempotent(db, request(k), work)).toEqual({ ...first, replayed: true });
    expect(runs).toBe(1);
    const [row] = await rows(k);
    expect(row).toMatchObject({ scope: SCOPE, resource_type: "order", resource_id: orderId });
    expect(row.response).toEqual({ orderNumber: "IH-001001", totalFils: 6500 });
    // About a day of replay by default.
    const life = row.expires_at.getTime() - row.created_at.getTime();
    expect(life).toBe(24 * 60 * 60 * 1000);
    // The key itself is nowhere in the table.
    const dump = JSON.stringify((await pool.query("SELECT * FROM idempotency_records")).rows);
    expect(dump).not.toContain(k);
    expect(Buffer.from(row.key_hash).equals(idempotencyKeyHash(SCOPE, k))).toBe(true);
  });
  it("refuses the same key with a different payload and leaves the first answer alone", async () => {
    const k = key();
    await runIdempotent(db, request(k), async () => ({ response: { ok: 1 } }));
    let ran = false;
    await expect(
      runIdempotent(db, request(k, payload({ couponCode: "EID10" })), async () => {
        ran = true;
        return { response: { ok: 2 } };
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(ran).toBe(false);
    expect((await rows(k))[0].response).toEqual({ ok: 1 });
    // The same key in another scope is a different command.
    const other = await runIdempotent(
      db,
      { ...request(k, payload({ couponCode: "EID10" })), scope: "admin.order.cancel" },
      async () => ({ response: { ok: 3 } }),
    );
    expect(other.replayed).toBe(false);
  });
  it("leaves nothing behind when the command fails, so the key can be used again", async () => {
    const k = key();
    await expect(
      runIdempotent(db, request(k), async (tx) => {
        await tx.$executeRawUnsafe("SELECT 1");
        throw new Error("synthetic business failure");
      }),
    ).rejects.toThrow("synthetic business failure");
    expect(await rows(k)).toHaveLength(0);
    // After correcting the request the same key is accepted, even with another payload.
    const retry = await runIdempotent(
      db,
      request(k, payload({ couponCode: "FIXED10" })),
      async () => ({
        response: { ok: true },
      }),
    );
    expect(retry.replayed).toBe(false);
    expect(await rows(k)).toHaveLength(1);
  });
  it("makes a waiting request the owner when the first attempt rolls back", async () => {
    const k = key();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const first = runIdempotent(db, request(k), async () => {
      entered();
      await gate;
      throw new Error("synthetic failure of the first attempt");
    });
    await inside;
    let secondStarted = 0;
    let secondRan = 0;
    const second = runIdempotent(db, request(k, payload({ couponCode: "RETRY10" })), async () => {
      secondRan = Date.now();
      return { response: { owner: "second" } };
    });
    secondStarted = Date.now();
    // The second request is really waiting on the first one's uncommitted claim.
    for (let n = 0; n < 100; n++) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name='ih-idempotency-test' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO idempotency_records%'",
      );
      if (waiting.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (n === 99) throw new Error("the second request never waited");
    }
    expect(secondRan).toBe(0);
    const released = Date.now();
    release();
    await expect(first).rejects.toThrow("synthetic failure of the first attempt");
    // Not "in progress", not a conflict: the key was never accepted, so the waiter runs.
    expect(await second).toMatchObject({ replayed: false, response: { owner: "second" } });
    expect(secondRan).toBeGreaterThanOrEqual(released);
    expect(secondStarted).toBeLessThanOrEqual(released);
    expect((await rows(k))[0].response).toEqual({ owner: "second" });
  });
  it("makes a waiting request replay when the first attempt commits", async () => {
    const k = key();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const first = runIdempotent(db, request(k), async () => {
      entered();
      await gate;
      return { response: { owner: "first" } };
    });
    await inside;
    let ran = false;
    const same = runIdempotent(db, request(k), async () => {
      ran = true;
      return { response: { owner: "same" } };
    });
    const different = runIdempotent(db, request(k, payload({ couponCode: "EID10" })), async () => {
      ran = true;
      return { response: { owner: "different" } };
    }).catch((error: unknown) => error);
    for (let n = 0; n < 100; n++) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='ih-idempotency-test' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO idempotency_records%'",
      );
      if (waiting.rows[0].n === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (n === 99) throw new Error("the two requests never waited");
    }
    release();
    await first;
    expect(await same).toMatchObject({ replayed: true, response: { owner: "first" } });
    expect(await different).toBeInstanceOf(IdempotencyConflictError);
    expect(ran).toBe(false);
  });
  it("runs once when the same request arrives many times at once", async () => {
    const k = key();
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        runIdempotent(db, request(k), async (tx) => {
          runs++;
          // Long enough that the others arrive while this one is still open.
          await tx.$executeRawUnsafe("SELECT pg_sleep(0.15)");
          return { response: { winner: runs } };
        }),
      ),
    );
    expect(runs).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify(result.response))).size).toBe(1);
    expect(await rows(k)).toHaveLength(1);
  });
  it("lets one of two different requests with one key win and refuses the other", async () => {
    const k = key();
    const attempt = (body: unknown, label: string) =>
      runIdempotent(db, request(k, body), async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_sleep(0.1)");
        return { response: { label } };
      });
    const results = await Promise.allSettled([
      attempt(payload(), "a"),
      attempt(payload({ couponCode: "EID10" }), "b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await rows(k)).toHaveLength(1);
  });
  it("answers 'in progress' after a bounded wait, then replays once the first attempt commits", async () => {
    const k = key();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const first = runIdempotent(db, request(k), async () => {
      entered();
      await gate;
      return { response: { ok: "first" } };
    });
    await inside;
    const started = Date.now();
    const second = await runIdempotent(db, request(k, payload(), { waitMs: 200 }), async () => ({
      response: { ok: "second" },
    })).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(IdempotencyInProgressError);
    expect(second).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await first;
    expect(
      await runIdempotent(db, request(k), async () => ({ response: { ok: "third" } })),
    ).toMatchObject({ replayed: true, response: { ok: "first" } });
    // The bounded wait does not leak into the rest of a transaction.
    const k2 = key();
    let after = "";
    await expect(
      withTransaction(db, async (tx) => {
        // A setting made earlier in the transaction is put back, not reset to the default.
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '7s'");
        await claimIdempotency(tx, request(k2, payload(), { waitMs: 200 }));
        const shown =
          await tx.$queryRawUnsafe<Array<{ lock_timeout: string }>>("SHOW lock_timeout");
        after = shown[0]?.lock_timeout ?? "";
        throw new Error("synthetic stop");
      }),
    ).rejects.toThrow("synthetic stop");
    expect(after).toBe("7s");
  });
  it("cannot commit a claim that was never answered", async () => {
    const k = key();
    await expect(
      withTransaction(db, async (tx) => {
        const claim = await claimIdempotency(tx, request(k));
        expect(claim.kind).toBe("claimed");
      }),
    ).rejects.toThrow(/must be answered before commit/);
    expect(await rows(k)).toHaveLength(0);
    // An answer is written once.
    const k2 = key();
    await expect(
      withTransaction(db, async (tx) => {
        const claim = await claimIdempotency(tx, request(k2));
        if (claim.kind !== "claimed") throw new Error("unexpected");
        await completeIdempotency(tx, claim.recordId, { response: { ok: 1 } });
        await completeIdempotency(tx, claim.recordId, { response: { ok: 2 } });
      }),
    ).rejects.toThrow("not open");
    await expect(claimIdempotency(db as never, request(key()))).rejects.toThrow("unit of work");
  });
  it("never treats an old key as new once its answer has expired", async () => {
    const k = key();
    const { orderId } = await seedOrder(pool);
    await runIdempotent(db, request(k, payload(), { ttlSeconds: 60 }), async () => ({
      response: { ok: true },
      resourceType: "order",
      resourceId: orderId,
    }));
    // Unexpired answers cannot be cleaned up, even on purpose.
    expect(await deleteExpiredIdempotencyRecords(db)).toBe(0);
    await expect(
      pool.query("DELETE FROM idempotency_records WHERE scope=$1 AND key_hash=$2", [
        SCOPE,
        idempotencyKeyHash(SCOPE, k),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    // Time passes (the guard forbids moving the expiry, so the test replaces the trigger's view
    // of time by back-dating both timestamps as the schema owner).
    await pool.query("ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_records_guard");
    await pool.query(
      "UPDATE idempotency_records SET created_at=created_at-interval '2 days', expires_at=expires_at-interval '2 days' WHERE scope=$1 AND key_hash=$2",
      [SCOPE, idempotencyKeyHash(SCOPE, k)],
    );
    await pool.query("ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_records_guard");
    let ran = false;
    const expired = await runIdempotent(db, request(k), async () => {
      ran = true;
      return { response: { ok: "again" } };
    }).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(IdempotencyExpiredError);
    expect(expired).toMatchObject({
      code: "CHECKOUT_RECOVERY_REQUIRED",
      resourceType: "order",
      resourceId: orderId,
    });
    expect(ran).toBe(false);
    // A different payload on an expired key is still a conflict, not a new command.
    await expect(
      runIdempotent(db, request(k, payload({ couponCode: "EID10" })), async () => ({
        response: {},
      })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await deleteExpiredIdempotencyRecords(db)).toBe(1);
    expect(await rows(k)).toHaveLength(0);
  });
  it("keeps a record's key, payload and answer fixed, and its answer bounded", async () => {
    const k = key();
    await runIdempotent(db, request(k), async () => ({ response: { ok: true } }));
    const where = "WHERE scope=$1 AND key_hash=$2";
    const params = [SCOPE, idempotencyKeyHash(SCOPE, k)];
    for (const change of [
      "payload_hash=sha256('x'::bytea)",
      "key_hash=sha256('x'::bytea)",
      "scope='other.scope'",
      "expires_at=expires_at+interval '1 year'",
      `response='{"ok":false}'::jsonb`,
      "response=NULL",
      "resource_type='order', resource_id=gen_random_uuid()",
    ])
      await expect(
        pool.query(`UPDATE idempotency_records SET ${change} ${where}`, params),
        change,
      ).rejects.toMatchObject({ code: "23514" });
    const oversize = await runIdempotent(db, request(key()), async () => ({
      response: { big: "x".repeat(20000) },
    })).catch((error: unknown) => error);
    expect(String((oversize as Error).message)).toMatch(/idempotency_response|23514/);
    // Bad inputs are refused before any statement.
    await expect(
      runIdempotent(db, { ...request(key()), payloadHash: Buffer.alloc(16) }, async () => ({
        response: {},
      })),
    ).rejects.toBeInstanceOf(IdempotencyKeyError);
    await expect(
      runIdempotent(db, request("short"), async () => ({ response: {} })),
    ).rejects.toBeInstanceOf(IdempotencyKeyError);
    // A nonsense wait or lifetime falls back to the bounded defaults.
    const odd = key();
    await runIdempotent(
      db,
      request(odd, payload(), { waitMs: Number.NaN, ttlSeconds: 1 }),
      async () => ({
        response: {},
      }),
    );
    const [bounded] = await rows(odd);
    expect(bounded.expires_at.getTime() - bounded.created_at.getTime()).toBe(60_000);
    const long = key();
    await runIdempotent(db, request(long, payload(), { ttlSeconds: 10 ** 9 }), async () => ({
      response: {},
    }));
    const [capped] = await rows(long);
    expect(capped.expires_at.getTime() - capped.created_at.getTime()).toBe(30 * 86_400_000);
    for (const bad of [
      ["Bad Scope", "sha256('k'::bytea)", "sha256('p'::bytea)"],
      [SCOPE, "'\\x00'::bytea", "sha256('p'::bytea)"],
      [SCOPE, "sha256('k'::bytea)", "'\\x00'::bytea"],
    ] as const)
      await expect(
        pool.query(
          `INSERT INTO idempotency_records (scope, key_hash, payload_hash, response, expires_at) VALUES ($1, ${bad[1]}, ${bad[2]}, '{}'::jsonb, statement_timestamp()+interval '1 day')`,
          [bad[0]],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO idempotency_records (scope, key_hash, payload_hash, response, expires_at) VALUES ($1, sha256('k2'::bytea), sha256('p'::bytea), '[]'::jsonb, statement_timestamp()+interval '1 day')`,
        [SCOPE],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    if (runtimeRole)
      for (const [privilege, expected] of [
        ["SELECT", true],
        ["INSERT", true],
        ["UPDATE", true],
        ["DELETE", true],
        ["TRUNCATE", false],
      ] as const)
        expect(
          (
            await pool.query<{ ok: boolean }>(
              `SELECT has_table_privilege('ih_app', $1 || '.idempotency_records', '${privilege}') AS ok`,
              [namespace],
            )
          ).rows[0]!.ok,
          privilege,
        ).toBe(expected);
  });
});
