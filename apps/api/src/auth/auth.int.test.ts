import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, createSession } from "@ih/db";
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
  applicationName: "ih-auth-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
// Minimum allowed argon2 cost keeps tests fast; production cost is benchmarked separately.
const fast = { memoryKib: 19_456, timeCost: 2, parallelism: 1 };
const hasher = new Argon2PasswordHasher(fast);
const PASSWORD = "copper-lantern-river-71";
const ADMIN_ORIGIN = "http://localhost:8081";

let app: INestApplication;
let base: string;

async function staff(
  email: string,
  role: "owner" | "staff",
  options: { active?: boolean; hash?: string } = {},
) {
  const roleRow = await db.role.findUniqueOrThrow({ where: { key: role } });
  return db.staffUser.create({
    data: {
      email,
      name: "Test " + role,
      roleId: roleRow.id,
      active: options.active ?? true,
      passwordHash: options.hash ?? (await hasher.hash(PASSWORD)),
    },
  });
}

const login = (email: string, password = PASSWORD, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: {
      origin: ADMIN_ORIGIN,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Chrome/126.0 Safari/537.36",
      "x-ih-client-ip": "203.0.113.77",
    },
    body: JSON.stringify({ email, password, ...extra }),
  });
const tokenOf = (response: Response) =>
  /__Host-ih_admin=([A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie") ?? "")?.[1];
const me = (token?: string) =>
  fetch(`${base}/v1/auth/me`, { headers: token ? { cookie: `__Host-ih_admin=${token}` } : {} });
const sha = (token: string) => createHash("sha256").update(token).digest();

describe("admin authentication and sessions (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const env = apiEnvSchema.parse({
      NODE_ENV: "test",
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: DATABASE_TEST_URL,
      QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
      ARGON2_MEMORY_KIB: fast.memoryKib,
      ARGON2_TIME_COST: fast.timeCost,
      ARGON2_PARALLELISM: fast.parallelism,
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    await staff("owner@iqoshaven.test", "owner");
    await staff("staff@iqoshaven.test", "staff");
    await staff("former@iqoshaven.test", "staff", { active: false });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("signs in with a __Host- session cookie and stores only the token hash", async () => {
    const response = await login("  Staff@IqosHaven.test ");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^__Host-ih_admin=[A-Za-z0-9_-]{43}; Max-Age=60479\d; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
    );
    expect(cookie).not.toMatch(/Domain=/i);
    const body = (await response.json()) as {
      user: { email: string; role: string };
      permissions: string[];
    };
    expect(body.user).toMatchObject({ email: "staff@iqoshaven.test", role: "staff" });
    expect(body.permissions).toHaveLength(15);
    expect(body.permissions).not.toContain("staff.manage");

    const token = tokenOf(response)!;
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect(session).toMatchObject({
      ipNetwork: "203.0.113.0/24",
      clientLabel: "Chrome on macOS",
      revokedAt: null,
    });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(7 * 24 * 3600 * 1000);
    const raw = await pool.query("SELECT row_to_json(s)::text AS row FROM sessions s");
    expect(raw.rows.map((row) => row.row).join("")).not.toContain(token);
  });

  it("returns the Owner's full permission set on /me", async () => {
    const token = tokenOf(await login("owner@iqoshaven.test"))!;
    const response = await me(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { user: { role: string }; permissions: string[] };
    expect(body.user.role).toBe("owner");
    expect(body.permissions).toHaveLength(33);
  });

  it("gives every failed sign-in the same generic answer", async () => {
    const attempts = [
      login("staff@iqoshaven.test", "wrong-password-entirely"),
      login("nobody@iqoshaven.test"),
      login("former@iqoshaven.test"),
      login("not-an-email"),
      login("staff@iqoshaven.test", "x".repeat(600)),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
  });

  it("rejects unknown fields and requires a session for /me, never caching errors", async () => {
    const invalid = await login("staff@iqoshaven.test", PASSWORD, { role: "owner" });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    const anonymous = await me();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect((await me("A".repeat(43))).status).toBe(401);
  });

  it("replaces the previous session on a new sign-in", async () => {
    const first = tokenOf(await login("staff@iqoshaven.test"))!;
    const second = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        "content-type": "application/json",
        cookie: `__Host-ih_admin=${first}`,
      },
      body: JSON.stringify({ email: "staff@iqoshaven.test", password: PASSWORD }),
    });
    expect(second.status).toBe(200);
    expect(tokenOf(second)).not.toBe(first);
    expect((await me(first)).status).toBe(401);
  });

  it("creates no session when the password changed after verification", async () => {
    const user = await staff("racing@iqoshaven.test", "staff");
    const created = await createSession(db, {
      userId: user.id,
      expectedPasswordHash: "$argon2id$v=19$m=19456,t=2,p=1$c3RhbGU$c3RhbGU", // a hash it no longer has
      tokenHash: sha("racing-token"),
      ipNetwork: null,
      clientLabel: null,
    });
    expect(created).toBeNull();
  });

  it("logs out by revoking the session and clearing the cookie", async () => {
    const token = tokenOf(await login("staff@iqoshaven.test"))!;
    const response = await fetch(`${base}/v1/auth/logout`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: `__Host-ih_admin=${token}` },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-ih_admin=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
    );
    expect((await me(token)).status).toBe(401);
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect(session.revokeReason).toBe("logout");
  });

  it("expires idle sessions after 12 hours and every session after 7 days", async () => {
    const idle = tokenOf(await login("staff@iqoshaven.test"))!;
    await pool.query(
      "UPDATE sessions SET created_at = now() - interval '14 hours', expires_at = now() + interval '6 days', last_seen_at = now() - interval '13 hours' WHERE token_hash = $1",
      [sha(idle)],
    );
    expect((await me(idle)).status).toBe(401);

    const old = tokenOf(await login("staff@iqoshaven.test"))!;
    await pool.query(
      "UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day', last_seen_at = now() - interval '1 minute' WHERE token_hash = $1",
      [sha(old)],
    );
    expect((await me(old)).status).toBe(401);
  });

  it("refreshes last-seen at most every 5 minutes without extending the absolute expiry", async () => {
    const token = tokenOf(await login("staff@iqoshaven.test"))!;
    await pool.query("UPDATE sessions SET last_seen_at = created_at WHERE token_hash = $1", [
      sha(token),
    ]);
    const before = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    await me(token);
    const recent = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect(recent.lastSeenAt).toEqual(before.lastSeenAt); // less than 5 minutes old: untouched

    await pool.query(
      "UPDATE sessions SET created_at = created_at - interval '10 minutes', last_seen_at = created_at - interval '10 minutes', expires_at = expires_at - interval '10 minutes' WHERE token_hash = $1",
      [sha(token)],
    );
    const stale = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect((await me(token)).status).toBe(200);
    const touched = await db.session.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(stale.lastSeenAt.getTime());
    expect(touched.expiresAt).toEqual(stale.expiresAt);
  });

  it("denies a deactivated user on the very next request", async () => {
    const user = await staff("leaving@iqoshaven.test", "staff");
    const token = tokenOf(await login("leaving@iqoshaven.test"))!;
    expect((await me(token)).status).toBe(200);
    await db.staffUser.update({
      where: { id: user.id },
      data: { active: false, version: { increment: 1 } },
    });
    expect((await me(token)).status).toBe(401);
  });

  it("upgrades a hash made with older parameters at sign-in", async () => {
    const legacy = new Argon2PasswordHasher({ memoryKib: 19_456, timeCost: 3, parallelism: 1 });
    const user = await staff("legacy@iqoshaven.test", "staff", {
      hash: await legacy.hash(PASSWORD),
    });
    expect((await login("legacy@iqoshaven.test")).status).toBe(200);
    const updated = await db.staffUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(updated.version).toBe(user.version);
    expect((await login("legacy@iqoshaven.test")).status).toBe(200);
  });
});
