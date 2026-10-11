import "reflect-metadata";
import { meResponseSchema } from "@ih/contracts";
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
  changeStaffRole,
  reactivateStaff,
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
  applicationName: "ih-role-test",
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
describe("fixed roles and reactivation through real API/PostgreSQL", () => {
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

  it("requires Owner permission and rejects unknown roles, fields, versions and IDs", async () => {
    for (const command of ["role", "reactivate"]) {
      const input = command === "role" ? { version: 1, role: "staff" } : { version: 1 };
      expect((await call(`/${ownerId}/${command}`, "POST", input, staffCookie)).status).toBe(403);
      expect((await call(`/${ownerId}/${command}`, "POST", input, "")).status).toBe(401);
      expect((await call(`/bad/${command}`, "POST", input)).status).toBe(400);
      expect((await call(`/${randomUUID()}/${command}`, "POST", input)).status).toBe(404);
      expect(
        (await call(`/${ownerId}/${command}`, "POST", { ...input, active: true })).status,
      ).toBe(400);
      expect((await call(`/${ownerId}/${command}`, "POST", { ...input, version: 0 })).status).toBe(
        400,
      );
    }
    expect((await call(`/${ownerId}/role`, "POST", { version: 1, role: "custom" })).status).toBe(
      400,
    );
    expect((await call(`/${ownerId}/role`, "POST", { version: 1, role: "staff" })).status).toBe(
      409,
    );
  });
  it("promotes and demotes with fresh seeded permissions and revokes all prior sessions", async () => {
    const target = await user();
    const before = await login(target.email);
    const secondSession = await login(target.email);
    const cap = await capabilities(target);
    const changed = await call(`/${target.id}/role`, "POST", { version: 1, role: "owner" });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("cache-control")).toBe("no-store");
    expect(await changed.json()).toMatchObject({ role: "owner", version: 2, active: true });
    expect((await me(before)).status).toBe(401);
    expect((await me(secondSession)).status).toBe(401);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).not.toBeNull();
    const promoted = await login(target.email);
    expect(meResponseSchema.parse(await (await me(promoted)).json()).permissions).toContain(
      "staff.manage",
    );
    expect((await call(`/${target.id}/role`, "POST", { version: 2, role: "staff" })).status).toBe(
      200,
    );
    expect((await me(promoted)).status).toBe(401);
    const demoted = await login(target.email);
    expect(meResponseSchema.parse(await (await me(demoted)).json()).permissions).not.toContain(
      "staff.manage",
    );
    expect(
      await db.auditLog.count({ where: { entityId: target.id, action: "staff.role_changed" } }),
    ).toBe(2);
    const events = await db.outboxEvent.findMany({
      where: { aggregateId: target.id, eventType: "staff.role_changed" },
    });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.payload).toEqual({ userId: target.id });
  });
  it("self-demotion clears the cookie and permanently revokes issued invitations", async () => {
    const target = await user(true, "owner");
    const cookie = await login(target.email);
    const cap = await capabilities(target);
    const r = await call(`/${target.id}/role`, "POST", { version: 1, role: "staff" }, cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await me(cookie)).status).toBe(401);
    expect(
      (await db.staffInvitationToken.findUniqueOrThrow({ where: { id: cap.invitationId! } }))
        .revokedAt,
    ).not.toBeNull();
  });
  it("reactivates with saved credentials but never revives old sessions or capabilities", async () => {
    const target = await user(true, "owner");
    const cookie = await login(target.email);
    const cap = await capabilities(target);
    await deactivateStaff(db, { actorId: ownerId, requestId: randomUUID() }, target.id, 1);
    const r = await call(`/${target.id}/reactivate`, "POST", { version: 2 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ role: "owner", active: true, version: 3 });
    expect((await me(cookie)).status).toBe(401);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).not.toBeNull();
    expect(
      (await db.staffInvitationToken.findUniqueOrThrow({ where: { id: cap.invitationId! } }))
        .revokedAt,
    ).not.toBeNull();
    expect((await me(await login(target.email))).status).toBe(200);
    await deactivateStaff(db, { actorId: ownerId, requestId: randomUUID() }, target.id, 3);
  });
  it("keeps inactive role changes inactive; rejects stale writes and preserves no-op versions/audit", async () => {
    const target = await user(false);
    expect((await call(`/${target.id}/role`, "POST", { version: 1, role: "owner" })).status).toBe(
      200,
    );
    expect(await db.staffUser.findUnique({ where: { id: target.id } })).toMatchObject({
      active: false,
      version: 2,
    });
    expect((await call(`/${target.id}/reactivate`, "POST", { version: 1 })).status).toBe(409);
    const context = { actorId: ownerId, requestId: randomUUID() };
    await changeStaffRole(db, context, target.id, { version: 2, role: "owner" });
    expect(
      await db.auditLog.count({ where: { entityId: target.id, action: "staff.role_changed" } }),
    ).toBe(1);
    await reactivateStaff(db, context, target.id, 2);
    await reactivateStaff(db, context, target.id, 3);
    expect(
      await db.auditLog.count({ where: { entityId: target.id, action: "staff.reactivated" } }),
    ).toBe(1);
    expect(await db.staffUser.findUnique({ where: { id: target.id } })).toMatchObject({
      active: true,
      version: 3,
    });
    await deactivateStaff(db, context, target.id, 3);
  });
  it("rolls back security changes and revocations on audit failure and denies direct Staff calls", async () => {
    const target = await user();
    const cookie = await login(target.email);
    const cap = await capabilities(target);
    await expect(
      changeStaffRole(db, { actorId: ownerId, requestId: "" }, target.id, {
        version: 1,
        role: "owner",
      }),
    ).rejects.toThrow();
    expect(await db.staffUser.findUnique({ where: { id: target.id } })).toMatchObject({
      roleId: target.roleId,
      version: 1,
    });
    expect((await me(cookie)).status).toBe(200);
    expect(
      (await db.passwordResetToken.findUniqueOrThrow({ where: { id: cap.resetId } })).usedAt,
    ).toBeNull();
    const inactive = await user(false);
    await expect(
      reactivateStaff(db, { actorId: ownerId, requestId: "" }, inactive.id, 1),
    ).rejects.toThrow();
    expect(await db.staffUser.findUnique({ where: { id: inactive.id } })).toMatchObject({
      active: false,
      version: 1,
    });
    for (const operation of [
      changeStaffRole(db, { actorId: target.id, requestId: randomUUID() }, inactive.id, {
        version: 1,
        role: "owner",
      }),
      reactivateStaff(db, { actorId: target.id, requestId: randomUUID() }, inactive.id, 1),
    ])
      await expect(operation).rejects.toMatchObject({ code: "STAFF_FORBIDDEN" });
  });
  it("serializes simultaneous role/reactivation edits and accepts only one expected version", async () => {
    const target = await user(false);
    const context = { actorId: ownerId, requestId: randomUUID() };
    const results = await Promise.allSettled([
      changeStaffRole(db, context, target.id, { version: 1, role: "owner" }),
      reactivateStaff(db, context, target.id, 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.version).toBe(2);
    if (row.active) await deactivateStaff(db, context, target.id, 2);
  });
  it("rechecks actor authority after actually waiting on the common Owner guard", async () => {
    const actor = await user(true, "owner");
    const target = await user(false);
    const holder = await pool.connect();
    let pending: ReturnType<typeof reactivateStaff> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM roles WHERE key = 'owner' FOR UPDATE");
      pending = reactivateStaff(db, { actorId: actor.id, requestId: randomUUID() }, target.id, 1);
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'ih-role-test' AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM roles%'",
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query(
        "UPDATE staff_users SET role_id = (SELECT id FROM roles WHERE key = 'staff'), version = version + 1 WHERE id = $1",
        [actor.id],
      );
      await holder.query("COMMIT");
      await expect(pending).rejects.toMatchObject({ code: "STAFF_FORBIDDEN" });
      expect(await db.staffUser.findUnique({ where: { id: target.id } })).toMatchObject({
        active: false,
        version: 1,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending?.catch(() => {});
    }
  });
  it("fences pre-role-change login even when password is unchanged", async () => {
    const target = await user();
    await changeStaffRole(db, { actorId: ownerId, requestId: randomUUID() }, target.id, {
      version: 1,
      role: "owner",
    });
    expect(
      await createSession(db, {
        userId: target.id,
        expectedUserVersion: 1,
        expectedPasswordHash: target.passwordHash,
        tokenHash: Buffer.alloc(32, 6),
        ipNetwork: null,
        clientLabel: null,
      }),
    ).toBeNull();
    await deactivateStaff(db, { actorId: ownerId, requestId: randomUUID() }, target.id, 2);
  });
  it("fails closed for both new commands when shared limiter is unavailable", async () => {
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
      for (const command of ["role", "reactivate"]) {
        const body = command === "role" ? { version: 1, role: "owner" } : { version: 1 };
        expect(
          (await call(`/${ownerId}/${command}`, "POST", body, ownerCookie, await other.getUrl()))
            .status,
        ).toBe(503);
      }
    } finally {
      await other.close();
    }
  });
  it("preserves the last Owner across simultaneous self-demotion and self-deactivation", async () => {
    const owner = await db.staffUser.findUniqueOrThrow({ where: { id: ownerId } });
    const second = await user(true, "owner");
    const cookie = await login(second.email);
    const responses = await Promise.all([
      call(`/${ownerId}/role`, "POST", { version: owner.version, role: "staff" }),
      call(`/${second.id}/deactivate`, "POST", { version: 1 }, cookie),
    ]);
    // Deactivation success is 204, demotion success 200; either must leave one active Owner.
    expect(responses.filter((r) => r.status === 200 || r.status === 204)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    expect(await db.staffUser.count({ where: { roleId: role.id, active: true } })).toBe(1);
    const remaining = await db.staffUser.findFirstOrThrow({
      where: { roleId: role.id, active: true },
    });
    const removedId = remaining.id === ownerId ? second.id : ownerId;
    const removed = await db.staffUser.findUniqueOrThrow({ where: { id: removedId } });
    const context = { actorId: remaining.id, requestId: randomUUID() };
    if (!removed.active) await reactivateStaff(db, context, removed.id, removed.version);
    else
      await changeStaffRole(db, context, removed.id, { version: removed.version, role: "owner" });
    const owners = await db.staffUser.findMany({ where: { roleId: role.id, active: true } });
    expect(owners).toHaveLength(2);
    const demotions = await Promise.allSettled(
      owners.map((o) =>
        changeStaffRole(db, { actorId: o.id, requestId: randomUUID() }, o.id, {
          version: o.version,
          role: "staff",
        }),
      ),
    );
    expect(demotions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(demotions.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(demotions.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "LAST_ACTIVE_OWNER" },
    });
    expect(await db.staffUser.count({ where: { roleId: role.id, active: true } })).toBe(1);
  });
});
