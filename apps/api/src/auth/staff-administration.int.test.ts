import "reflect-metadata";
import { randomUUID, createHash } from "node:crypto";
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
  issueStaffInvitation,
  issuePasswordReset,
  editStaff,
  deactivateStaff,
  createSession,
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
  applicationName: "ih-staff-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = { keyId: "test", secret: Buffer.alloc(32, 9).toString("base64url") };
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
  STAFF_INVITATION_KEYS: `invite:${key.keyId}:${key.secret}`,
  STAFF_INVITATION_ORIGIN: ADMIN,
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
  fetch(`${root}/v1/admin/staff${path}`, {
    method,
    headers: {
      cookie,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
      "x-ih-client-ip": "192.0.2.2",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const me = (cookie: string) => fetch(`${base}/v1/auth/me`, { headers: { cookie } });
async function capabilities(staff: { id: string; email: string; roleId: string }) {
  const resetId = randomUUID();
  const invitationId = randomUUID();
  await issuePasswordReset(
    db,
    { actorId: null, requestId: randomUUID() },
    {
      email: staff.email,
      id: resetId,
      tokenHash: createHash("sha256").update(randomUUID()).digest(),
      recipientHash: Buffer.alloc(32, 1),
      keyId: "fixture",
    },
  );
  const owner = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
  if (staff.roleId === owner.id)
    await issueStaffInvitation(
      db,
      { actorId: staff.id, requestId: randomUUID() },
      {
        id: invitationId,
        email: `invite${seq++}@iqoshaven.test`,
        name: "Sam Person",
        role: "staff",
        tokenHash: Buffer.alloc(32, seq),
        keyId: "fixture",
      },
    );
  return { resetId, invitationId: staff.roleId === owner.id ? invitationId : null };
}
describe("staff administration through real API/PostgreSQL", () => {
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
  it("allows only Owner staff.manage access, with bounded keyset pages and sanitized fields", async () => {
    for (const cookie of ["", staffCookie]) {
      const expected = cookie ? 403 : 401;
      expect((await call("", "GET", undefined, cookie)).status).toBe(expected);
      expect(
        (await call(`/${randomUUID()}`, "PATCH", { version: 1, name: "Edited" }, cookie)).status,
      ).toBe(expected);
      expect(
        (await call(`/${randomUUID()}/deactivate`, "POST", { version: 1 }, cookie)).status,
      ).toBe(expected);
    }
    const first = await call("?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0]!.id);
    const second = await call(`?limit=1&after=${page.nextCursor}`);
    const text = await second.text();
    expect(text).not.toMatch(/passwordHash|tokenHash|totp|sessions/);
    expect(JSON.parse(text).items[0].id).not.toBe(page.items[0]!.id);
    for (const query of ["?limit=0", "?limit=101", "?after=bad", "?role=owner"])
      expect((await call(query)).status).toBe(400);
  });
  it("rejects invalid input, stale versions, nonexistent users and role/activation edits", async () => {
    const staff = await user();
    expect((await call("/bad", "PATCH", { version: 1, name: "Edited" })).status).toBe(400);
    expect((await call(`/${randomUUID()}`, "PATCH", { version: 1, name: "Edited" })).status).toBe(
      404,
    );
    for (const body of [
      { version: 1 },
      { version: 0, name: "Edited" },
      { version: 1, name: " " },
      { version: 1, name: "Edited", role: "owner" },
      { version: 1, active: true },
    ])
      expect((await call(`/${staff.id}`, "PATCH", body)).status).toBe(400);
    expect((await call(`/${staff.id}`, "PATCH", { version: 2, name: "Edited" })).status).toBe(409);
    expect(
      (
        await call(`/${staff.id}`, "PATCH", {
          version: 1,
          email: (await db.staffUser.findUniqueOrThrow({ where: { id: ownerId } })).email,
        })
      ).status,
    ).toBe(409);
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).version).toBe(1);
  });
  it("applies one of concurrent versioned edits, redacts audit PII and leaves no-op unchanged", async () => {
    const staff = await user();
    const cookie = await login(staff.email);
    const responses = await Promise.all(
      ["Alpha", "Beta"].map((name) => call(`/${staff.id}`, "PATCH", { version: 1, name })),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.version).toBe(2);
    expect((await me(cookie)).status).toBe(200);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: staff.id, action: "staff.updated" },
    });
    expect(audit.diff).toMatchObject({ name: { redacted: true } });
    expect((await call(`/${staff.id}`, "PATCH", { version: 2, name: row.name })).status).toBe(200);
    expect(
      await db.auditLog.count({ where: { entityId: staff.id, action: "staff.updated" } }),
    ).toBe(1);
  });
  it("changes email with all-session and reset revocation; old identity cannot start new sessions", async () => {
    const staff = await user();
    const first = await login(staff.email);
    const second = await login(staff.email);
    const cap = await capabilities(staff);
    const email = `changed${seq++}@iqoshaven.test`;
    const response = await call(`/${staff.id}`, "PATCH", { version: 1, email });
    expect(response.status).toBe(200);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).not.toBeNull();
    expect(
      await db.session.count({ where: { userId: staff.id, revokeReason: "admin_revoked" } }),
    ).toBe(2);
    expect(
      await createSession(db, {
        userId: staff.id,
        expectedUserVersion: 1,
        expectedPasswordHash: staff.passwordHash,
        tokenHash: Buffer.alloc(32, 5),
        ipNetwork: null,
        clientLabel: null,
      }),
    ).toBeNull();
    expect(
      (await post("login", { email: staff.email, password: PASSWORD }, "192.0.2.3")).status,
    ).toBe(401);
    expect((await me(await login(email))).status).toBe(200);
  });
  it("clears the admin cookie when an Owner changes their own email", async () => {
    const self = await user(true, "owner");
    const cookie = await login(self.email);
    const email = `self${seq++}@iqoshaven.test`;
    const response = await call(`/${self.id}`, "PATCH", { version: self.version, email }, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await me(cookie)).status).toBe(401);
    expect((await me(await login(email))).status).toBe(200);
    expect((await call(`/${self.id}/deactivate`, "POST", { version: 2 })).status).toBe(204);
  });
  it("deactivates without deletion and permanently revokes sessions, reset and issued invitations", async () => {
    const target = await user(true, "owner");
    const cookie = await login(target.email);
    const cap = await capabilities(target);
    expect((await call(`/${target.id}/deactivate`, "POST", { version: 1 })).status).toBe(204);
    expect((await me(cookie)).status).toBe(401);
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.active).toBe(false);
    expect(row.version).toBe(2);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).not.toBeNull();
    expect(
      (await db.staffInvitationToken.findUniqueOrThrow({ where: { id: cap.invitationId! } }))
        .revokedAt,
    ).not.toBeNull();
    expect((await call(`/${target.id}/deactivate`, "POST", { version: 1 })).status).toBe(409);
    expect((await call(`/${target.id}/deactivate`, "POST", { version: 2 })).status).toBe(204);
    expect(
      await db.auditLog.count({ where: { entityId: target.id, action: "staff.deactivated" } }),
    ).toBe(1);
    expect(
      (await post("login", { email: target.email, password: PASSWORD }, "192.0.2.4")).status,
    ).toBe(401);
  });
  it("rolls back edits and deactivation/revocation when audit fails; repository rechecks Staff denial", async () => {
    const target = await user();
    const cookie = await login(target.email);
    const cap = await capabilities(target);
    await expect(
      editStaff(db, { actorId: ownerId, requestId: "" }, target.id, {
        version: 1,
        email: "rollback@iqoshaven.test",
      }),
    ).rejects.toThrow();
    await expect(
      deactivateStaff(db, { actorId: ownerId, requestId: "" }, target.id, 1),
    ).rejects.toThrow();
    expect(await db.staffUser.findUnique({ where: { id: target.id } })).toMatchObject({
      version: 1,
      active: true,
      email: target.email,
    });
    expect((await me(cookie)).status).toBe(200);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).toBeNull();
    await expect(
      editStaff(db, { actorId: target.id, requestId: randomUUID() }, ownerId, {
        version: 1,
        name: "Forbidden",
      }),
    ).rejects.toMatchObject({ code: "STAFF_FORBIDDEN" });
  });
  it("rejects old-version login after waiting behind an email edit with unchanged password", async () => {
    const staff = await user();
    const holder = await pool.connect();
    let pending: ReturnType<typeof createSession> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE staff_users SET email = $2, version = version + 1 WHERE id = $1", [
        staff.id,
        `wait${seq++}@iqoshaven.test`,
      ]);
      pending = createSession(db, {
        userId: staff.id,
        expectedUserVersion: 1,
        expectedPasswordHash: staff.passwordHash,
        tokenHash: Buffer.alloc(32, 6),
        ipNetwork: null,
        clientLabel: null,
      });
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'ih-staff-test' AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM staff_users%'",
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query("COMMIT");
      expect(await pending).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });
  it("fails closed for writes when the shared limiter is down", async () => {
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
        (
          await call(
            `/${ownerId}`,
            "PATCH",
            { version: 1, name: "Edited" },
            ownerCookie,
            await other.getUrl(),
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await call(
            `/${ownerId}/deactivate`,
            "POST",
            { version: 1 },
            ownerCookie,
            await other.getUrl(),
          )
        ).status,
      ).toBe(503);
    } finally {
      await other.close();
    }
  });
  it("protects the last active Owner, including two simultaneous self-deactivations", async () => {
    const owner = await db.staffUser.findUniqueOrThrow({ where: { id: ownerId } });
    expect((await call(`/${ownerId}/deactivate`, "POST", { version: owner.version })).status).toBe(
      409,
    );
    const second = await user(true, "owner");
    const secondCookie = await login(second.email);
    const responses = await Promise.all([
      call(`/${ownerId}/deactivate`, "POST", { version: owner.version }),
      call(`/${second.id}/deactivate`, "POST", { version: second.version }, secondCookie),
    ]);
    expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    const ownerRole = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    expect(await db.staffUser.count({ where: { roleId: ownerRole.id, active: true } })).toBe(1);
  });
});
