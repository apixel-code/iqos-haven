import "reflect-metadata";
import { randomUUID, createHash } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, createSession, consumePasswordReset } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher, resetToken } from "@ih/platform";
import { type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-reset-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = { keyId: "test", secret: Buffer.alloc(32, 9).toString("base64url") };
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const NEXT = "violet-sunrise-mountain-93";
const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  PASSWORD_RESET_KEYS: `reset:${key.keyId}:${key.secret}`,
  PASSWORD_RESET_ORIGIN: ADMIN,
});
let app: INestApplication;
let base: string;
let seq = 0;
async function user(active = true, roleKey: "owner" | "staff" = "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `reset${seq++}@iqoshaven.test`,
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
async function issue(email: string) {
  expect((await post("forgot", { email }, `192.0.2.${seq + 1}`)).status).toBe(200);
  const reset = await db.passwordResetToken.findFirstOrThrow({
    where: { user: { email } },
    orderBy: { createdAt: "desc" },
  });
  return { reset, token: resetToken(reset.id, key) };
}

describe("password reset through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("returns the same response for known, unknown, inactive and malformed identities", async () => {
    const active = await user();
    const inactive = await user(false);
    for (const email of [active.email, inactive.email, "missing@iqoshaven.test", "bad-email"]) {
      const response = await post("forgot", { email }, "203.0.113.1");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await db.passwordResetToken.count()).toBe(1);
    const reset = await db.passwordResetToken.findFirstOrThrow();
    expect(reset.tokenHash).toHaveLength(32);
    expect(reset.expiresAt.getTime() - reset.createdAt.getTime()).toBe(30 * 60_000);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: active.id },
      include: { effects: true },
    });
    expect(event.payload).toEqual({ resetId: reset.id });
    expect(event.effects.map((x) => x.consumer)).toEqual(["email"]);
    expect(JSON.stringify(event)).not.toContain(active.email);
    const token = resetToken(reset.id, key);
    const stored = await pool.query(
      "SELECT row_to_json(r)::text AS data FROM password_reset_tokens r",
    );
    expect(JSON.stringify(stored.rows)).not.toContain(token);
  });
  it("changes the password once, revokes every session and invalidates sibling links", async () => {
    const staff = await user();
    for (let i = 0; i < 2; i++)
      expect(
        (await post("login", { email: staff.email, password: PASSWORD }, "203.0.113.2")).status,
      ).toBe(200);
    const first = await issue(staff.email);
    const second = await issue(staff.email);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("reset", { token: second.token, password: NEXT }, "203.0.113.3"),
      ),
    );
    expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(4);
    expect(
      (await post("reset", { token: first.token, password: PASSWORD }, "203.0.113.4")).status,
    ).toBe(400);
    expect(await db.session.count({ where: { userId: staff.id, revokedAt: null } })).toBe(0);
    expect(
      await db.session.count({ where: { userId: staff.id, revokeReason: "password_reset" } }),
    ).toBe(2);
    expect(
      (await post("login", { email: staff.email, password: PASSWORD }, "203.0.113.5")).status,
    ).toBe(401);
    expect(
      (await post("login", { email: staff.email, password: NEXT }, "203.0.113.5")).status,
    ).toBe(200);
    expect(
      await db.auditLog.count({ where: { entityId: staff.id, action: "staff.password_reset" } }),
    ).toBe(1);
  });
  it("does not create an old-password session that waited behind a password change", async () => {
    const staff = await user();
    const holder = await pool.connect();
    let pending: ReturnType<typeof createSession> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE staff_users SET password_hash = $2, version = version + 1 WHERE id = $1",
        [staff.id, await hasher.hash(NEXT)],
      );
      pending = createSession(db, {
        userId: staff.id,
        expectedUserVersion: staff.version,
        expectedPasswordHash: staff.passwordHash,
        tokenHash: createHash("sha256").update(randomUUID()).digest(),
        ipNetwork: null,
        clientLabel: null,
      });
      // Observe the actual database wait rather than relying on sleep ordering.
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'ih-reset-test' AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM staff_users%'",
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query(
        "UPDATE sessions SET revoked_at = statement_timestamp(), revoke_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
        [staff.id],
      );
      await holder.query("COMMIT");
      expect(await pending).toBeNull();
      expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });
  it("rolls back token consumption, password and sessions if the atomic audit fails", async () => {
    const staff = await user();
    const { reset, token } = await issue(staff.email);
    await post("login", { email: staff.email, password: PASSWORD }, "203.0.113.11");
    await expect(
      consumePasswordReset(
        db,
        { requestId: "", actorId: null },
        {
          id: reset.id,
          tokenHash: createHash("sha256").update(token).digest(),
          userId: staff.id,
          userVersion: staff.version,
          passwordHash: await hasher.hash(NEXT),
        },
      ),
    ).rejects.toThrow();
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).passwordHash).toBe(
      staff.passwordHash,
    );
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: reset.id } })).usedAt,
    ).toBeNull();
    expect(await db.session.count({ where: { userId: staff.id, revokedAt: null } })).toBe(1);
  });
  it("rejects expired, inactive, changed-account and tampered tokens without mutation", async () => {
    for (const mode of ["expired", "inactive", "changed", "tampered"]) {
      const staff = await user();
      const { reset, token } = await issue(staff.email);
      if (mode === "expired")
        await pool.query(
          "UPDATE password_reset_tokens SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' WHERE id = $1",
          [reset.id],
        );
      if (mode === "inactive")
        await db.staffUser.update({ where: { id: staff.id }, data: { active: false } });
      if (mode === "changed")
        await db.staffUser.update({ where: { id: staff.id }, data: { version: { increment: 1 } } });
      const response = await post(
        "reset",
        {
          token:
            mode === "tampered" ? token.slice(0, -1) + (token.endsWith("A") ? "B" : "A") : token,
          password: NEXT,
        },
        "203.0.113.6",
      );
      expect(response.status).toBe(400);
      expect((await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).passwordHash).toBe(
        staff.passwordHash,
      );
      expect(
        (await db.passwordResetToken.findUniqueOrThrow({ where: { id: reset.id } })).usedAt,
      ).toBeNull();
    }
  });
  it("rejects weak passwords without burning the token and accepts NFKC normalization", async () => {
    const staff = await user();
    const { token } = await issue(staff.email);
    for (const password of ["short", "Password1234!", "test-person-garden-51", "x".repeat(1024)])
      expect((await post("reset", { token, password }, "203.0.113.7")).status).toBe(400);
    expect(
      (await post("reset", { token, password: "violet-lantern-e\u0301clair-93" }, "203.0.113.7"))
        .status,
    ).toBe(204);
    expect(
      (
        await post(
          "login",
          { email: staff.email, password: "violet-lantern-éclair-93" },
          "203.0.113.7",
        )
      ).status,
    ).toBe(200);
  });
  it("lets the Owner send a staff member a reset link, audited as the Owner (G-A11)", async () => {
    const owner = await user(true, "owner");
    const staff = await user();
    const other = await user();
    const inactive = await user(false);
    const cookie = async (email: string) => {
      const response = await post("login", { email, password: PASSWORD }, "203.0.113.40");
      expect(response.status).toBe(200);
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const ownerCookie = await cookie(owner.email);
    const staffCookie = await cookie(other.email);
    const send = (id: string, session = ownerCookie) =>
      fetch(`${base}/v1/admin/staff/${id}/password-reset`, {
        method: "POST",
        headers: { origin: ADMIN, cookie: session, "x-ih-client-ip": "203.0.113.41" },
      });
    expect((await send(staff.id, staffCookie)).status).toBe(403);
    expect(await db.passwordResetToken.count({ where: { userId: staff.id } })).toBe(0);
    const response = await send(staff.id);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reset = await db.passwordResetToken.findFirstOrThrow({ where: { userId: staff.id } });
    expect(reset.expiresAt.getTime() - reset.createdAt.getTime()).toBe(30 * 60_000);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "staff.password_reset_requested", entityId: staff.id },
    });
    expect(audit.actorId).toBe(owner.id);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: staff.id, eventType: "staff.password_reset_requested" },
      include: { effects: true },
    });
    expect(event.payload).toEqual({ resetId: reset.id });
    expect(event.effects.map((x) => x.consumer)).toEqual(["email"]);
    // The link works like a self-service one.
    expect(
      (await post("reset", { token: resetToken(reset.id, key), password: NEXT }, "203.0.113.42"))
        .status,
    ).toBe(204);
    const inactiveResponse = await send(inactive.id);
    expect(inactiveResponse.status).toBe(409);
    expect(((await inactiveResponse.json()) as { error: { code: string } }).error.code).toBe(
      "STAFF_INACTIVE",
    );
    expect((await send(randomUUID())).status).toBe(404);
    expect((await send("not-a-uuid")).status).toBe(400);
    expect(await db.passwordResetToken.count({ where: { userId: inactive.id } })).toBe(0);
  });
  it("enforces Origin, strict body schemas and temporary request/consume limits", async () => {
    expect(
      (await post("forgot", { email: "x@x.test" }, "203.0.113.8", "https://evil.test")).status,
    ).toBe(403);
    expect((await post("forgot", { email: "x@x.test", role: "owner" }, "203.0.113.8")).status).toBe(
      400,
    );
    for (let i = 0; i < 3; i++)
      expect((await post("forgot", { email: "budget@iqoshaven.test" }, "203.0.113.8")).status).toBe(
        200,
      );
    const limited = await post("forgot", { email: " BUDGET@iqoshaven.test " }, "203.0.113.8");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    for (let i = 0; i < 20; i++)
      expect((await post("reset", { token: "junk", password: NEXT }, "203.0.113.9")).status).toBe(
        400,
      );
    expect((await post("reset", { token: "junk", password: NEXT }, "203.0.113.9")).status).toBe(
      429,
    );
  });
  it("fails closed on missing keys and on replicated limiter outage", async () => {
    for (const override of [
      { PASSWORD_RESET_KEYS: [] },
      {
        RATE_LIMIT_PROFILE: "replicated" as const,
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
    ]) {
      const other = await createApp({ ...env, ...override }, { pool, database: db });
      await other.listen(0, "127.0.0.1");
      try {
        for (const path of ["forgot", "reset"])
          expect(
            (
              await post(
                path,
                path === "forgot" ? { email: "x@x.test" } : { token: "junk", password: NEXT },
                "203.0.113.10",
                ADMIN,
                await other.getUrl(),
              )
            ).status,
          ).toBe(503);
      } finally {
        await other.close();
      }
    }
  });
});
