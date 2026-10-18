import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, issueStaffInvitation, acceptStaffInvitation } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher, invitationToken, invitationTokenHash } from "@ih/platform";
import { type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-invitation-test",
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
  STAFF_INVITATION_KEYS: `invite:${key.keyId}:${key.secret}`,
  STAFF_INVITATION_ORIGIN: ADMIN,
});
let app: INestApplication;
let base: string;
let seq = 0;
async function user(active = true) {
  const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
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
let staffCookie: string;
let ownerId: string;
const manage = (path: string, body: unknown, cookie = ownerCookie, root = base) =>
  fetch(`${root}/v1/admin/staff/invitations${path}`, {
    method: "POST",
    headers: {
      origin: ADMIN,
      "content-type": "application/json",
      cookie,
      "x-ih-client-ip": "192.0.2.100",
    },
    body: JSON.stringify(body),
  });
async function login(email: string) {
  const response = await post("login", { email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function invite(role: "owner" | "staff" = "staff", email = `invite${seq++}@iqoshaven.test`) {
  const response = await manage("", { email, name: "Sam Person", role });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; expiresAt: string };
  return { ...body, email, token: invitationToken(body.id, key) };
}
const accept = (token: string, password = NEXT, ip = "203.0.113.2") =>
  post("invite/accept", { token, password }, ip);
describe("staff invitations through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const owner = await db.staffUser.create({
      data: {
        email: "owner@iqoshaven.test",
        name: "Owner",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
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
  it("requires staff.manage for issue/revoke and validates server-approved input", async () => {
    const input = { email: "new@iqoshaven.test", name: "Sam Person", role: "staff" };
    for (const path of ["", "/revoke"]) {
      const body = path ? { invitationId: randomUUID() } : input;
      expect((await manage(path, body, "")).status).toBe(401);
      expect((await manage(path, body, staffCookie)).status).toBe(403);
    }
    expect((await manage("", { ...input, role: "superuser" })).status).toBe(400);
    expect((await manage("", { ...input, name: " " })).status).toBe(400);
    expect((await manage("/revoke", { invitationId: "bad" })).status).toBe(400);
    expect(
      (await post("invite/accept", { token: "junk", password: NEXT, role: "owner" })).status,
    ).toBe(400);
  });
  it("stores hash-only 24-hour snapshots and accepts exactly once with the saved role", async () => {
    const data = await invite("owner");
    const row = await db.staffInvitationToken.findUniqueOrThrow({ where: { id: data.id } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * 3600_000);
    expect(row.tokenHash).toHaveLength(32);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: data.id, eventType: "staff.invited" },
      include: { effects: true },
    });
    expect(event.payload).toEqual({ invitationId: data.id });
    expect(event.effects.map((x) => x.consumer)).toEqual(["email"]);
    expect(JSON.stringify(event)).not.toContain(data.email);
    const stored = await pool.query(
      "SELECT row_to_json(i)::text AS data FROM staff_invitation_tokens i",
    );
    expect(JSON.stringify(stored.rows)).not.toContain(data.token);
    const responses = await Promise.all(Array.from({ length: 5 }, () => accept(data.token)));
    expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(4);
    expect(responses.every((r) => r.headers.get("set-cookie") === null)).toBe(true);
    const created = await db.staffUser.findUniqueOrThrow({
      where: { email: data.email },
      include: { role: true },
    });
    expect(created.role.key).toBe("owner");
    expect(created.active).toBe(true);
    expect(await hasher.verify(created.passwordHash, NEXT)).toBe(true);
    expect(
      await db.auditLog.count({
        where: { entityId: created.id, action: "staff.invitation_accepted" },
      }),
    ).toBe(1);
  });
  it("reissues by revoking old snapshots, and revokes idempotently", async () => {
    const first = await invite();
    const second = await invite("staff", first.email);
    expect((await accept(first.token)).status).toBe(400);
    expect((await manage("/revoke", { invitationId: second.id })).status).toBe(204);
    expect((await manage("/revoke", { invitationId: second.id })).status).toBe(204);
    expect((await accept(second.token)).status).toBe(400);
    expect(
      await db.auditLog.count({
        where: { entityId: second.id, action: "staff.invitation_revoked" },
      }),
    ).toBe(1);
  });
  it("cannot overwrite or reactivate existing accounts", async () => {
    const existing = await user(false);
    expect(
      (await manage("", { email: existing.email, name: "Replacement", role: "owner" })).status,
    ).toBe(409);
    const pending = await invite();
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const raced = await db.staffUser.create({
      data: {
        email: pending.email,
        name: "Existing",
        active: false,
        roleId: role.id,
        passwordHash: existing.passwordHash,
      },
    });
    expect((await accept(pending.token)).status).toBe(400);
    expect(await db.staffUser.findUnique({ where: { id: raced.id } })).toMatchObject({
      active: false,
      passwordHash: existing.passwordHash,
      roleId: role.id,
    });
  });
  it("rejects expiry, tampering and deactivated inviter; preserves token for weak-password correction", async () => {
    const data = await invite();
    expect((await accept(data.token, "Password1234!")).status).toBe(400);
    expect(
      (await accept(data.token.slice(0, -1) + (data.token.endsWith("A") ? "B" : "A"))).status,
    ).toBe(400);
    await db.staffUser.update({ where: { id: ownerId }, data: { active: false } });
    try {
      expect((await accept(data.token)).status).toBe(400);
    } finally {
      await db.staffUser.update({ where: { id: ownerId }, data: { active: true } });
    }
    expect((await accept(data.token, "violet-lantern-e\u0301clair-93")).status).toBe(204);
    const expired = await invite();
    await manage("/revoke", { invitationId: expired.id });
    const id = randomUUID();
    const token = invitationToken(id, key);
    await pool.query(
      "INSERT INTO staff_invitation_tokens (id,email,name,role_id,invited_by,token_hash,key_id,created_at,expires_at) SELECT $1,email,name,role_id,invited_by,$2,key_id,created_at - interval '25 hours',expires_at - interval '25 hours' FROM staff_invitation_tokens WHERE id = $3",
      [id, invitationTokenHash(token), expired.id],
    );
    expect((await accept(token)).status).toBe(400);
  });
  it("enforces immutable recipient/role snapshots and atomic audit rollback", async () => {
    const data = await invite();
    await expect(
      db.staffInvitationToken.update({
        where: { id: data.id },
        data: { email: "redirect@iqoshaven.test" },
      }),
    ).rejects.toThrow();
    await expect(
      acceptStaffInvitation(db, "", {
        id: data.id,
        tokenHash: invitationTokenHash(data.token),
        passwordHash: await hasher.hash(NEXT),
      }),
    ).rejects.toThrow();
    expect(await db.staffUser.findUnique({ where: { email: data.email } })).toBeNull();
    expect(
      (await db.staffInvitationToken.findUniqueOrThrow({ where: { id: data.id } })).acceptedAt,
    ).toBeNull();
    await expect(
      issueStaffInvitation(
        db,
        { requestId: "", actorId: ownerId },
        {
          id: randomUUID(),
          email: data.email,
          name: "Sam",
          role: "staff",
          tokenHash: invitationTokenHash("fixture"),
          keyId: key.keyId,
        },
      ),
    ).rejects.toThrow();
    expect(
      (await db.staffInvitationToken.findUniqueOrThrow({ where: { id: data.id } })).revokedAt,
    ).toBeNull();
  });
  it("rechecks revocation after acceptance waits on the common Owner guard", async () => {
    const data = await invite();
    const holder = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM roles WHERE key = 'owner' FOR UPDATE");
      pending = accept(data.token, NEXT, "203.0.113.53");
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const observed = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'ih-invitation-test' AND wait_event_type = 'Lock' AND query LIKE '%FROM roles%FOR UPDATE%'",
        );
        if (observed.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query(
        "UPDATE staff_invitation_tokens SET revoked_at = statement_timestamp(), version = version + 1 WHERE id = $1",
        [data.id],
      );
      await holder.query("COMMIT");
      expect((await pending).status).toBe(400);
      expect(await db.staffUser.findUnique({ where: { email: data.email } })).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  });
  it("serializes concurrent resends to one pending invite and refuses Staff at repository boundary", async () => {
    const email = `race${seq++}@iqoshaven.test`;
    const results = await Promise.all(
      Array.from({ length: 3 }, () => manage("", { email, name: "Sam", role: "staff" })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(
      await db.staffInvitationToken.count({ where: { email, revokedAt: null, acceptedAt: null } }),
    ).toBe(1);
    const staff = await user();
    await expect(
      issueStaffInvitation(
        db,
        { requestId: randomUUID(), actorId: staff.id },
        {
          id: randomUUID(),
          email: "forged@iqoshaven.test",
          name: "Sam",
          role: "owner",
          tokenHash: invitationTokenHash("fixture"),
          keyId: key.keyId,
        },
      ),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_ALLOWED" });
  });
  it("lists pending invitations for staff.manage only, newest first, without accepted or revoked ones (G-A11)", async () => {
    const list = async (cookie = ownerCookie) =>
      fetch(`${base}/v1/admin/staff/invitations`, {
        headers: { cookie, "x-ih-client-ip": "192.0.2.101" },
      });
    const kept = await invite("owner");
    const revoked = await invite();
    const accepted = await invite();
    // An expired pending invitation: copied from a revoked one with its times moved back.
    const source = await invite();
    await manage("/revoke", { invitationId: source.id });
    const expired = { id: randomUUID() };
    await pool.query(
      "INSERT INTO staff_invitation_tokens (id,email,name,role_id,invited_by,token_hash,key_id,created_at,expires_at) SELECT $1,email,name,role_id,invited_by,$2,key_id,created_at - interval '25 hours',expires_at - interval '25 hours' FROM staff_invitation_tokens WHERE id = $3",
      [expired.id, invitationTokenHash(invitationToken(expired.id, key)), source.id],
    );
    expect((await manage("/revoke", { invitationId: revoked.id })).status).toBe(204);
    expect((await accept(accepted.token)).status).toBe(204);
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { items } = (await response.json()) as {
      items: Array<{
        id: string;
        email: string;
        role: string;
        invitedBy: string;
        expired: boolean;
      }>;
    };
    const ids = items.map((item) => item.id);
    expect(ids).toContain(kept.id);
    expect(ids).toContain(expired.id);
    expect(ids).not.toContain(revoked.id);
    expect(ids).not.toContain(accepted.id);
    expect(ids.indexOf(kept.id)).toBeLessThan(ids.indexOf(expired.id));
    expect(items.find((item) => item.id === kept.id)).toMatchObject({
      email: kept.email,
      role: "owner",
      invitedBy: "Owner",
      expired: false,
    });
    expect(items.find((item) => item.id === expired.id)!.expired).toBe(true);
    // The token never leaves the server.
    expect(JSON.stringify(items)).not.toContain(kept.token);
    // Revoking from the list removes it.
    expect((await manage("/revoke", { invitationId: expired.id })).status).toBe(204);
    const after = (await (await list()).json()) as { items: Array<{ id: string }> };
    expect(after.items.map((item) => item.id)).not.toContain(expired.id);
    expect((await list(staffCookie)).status).toBe(403);
    expect((await list("")).status).toBe(401);
  });

  it("enforces Origin/rate limits and fails closed on missing keys or shared limiter outage", async () => {
    expect(
      (
        await post(
          "invite/accept",
          { token: "junk", password: NEXT },
          "203.0.113.50",
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    for (let i = 0; i < 20; i++)
      expect((await accept("junk", NEXT, "203.0.113.51")).status).toBe(400);
    const limited = await accept("junk", NEXT, "203.0.113.51");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    for (const override of [
      { STAFF_INVITATION_KEYS: [] },
      {
        RATE_LIMIT_PROFILE: "replicated" as const,
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
    ]) {
      const other = await createApp({ ...env, ...override }, { pool, database: db });
      await other.listen(0, "127.0.0.1");
      try {
        expect(
          (
            await post(
              "invite/accept",
              { token: "junk", password: NEXT },
              "203.0.113.52",
              ADMIN,
              await other.getUrl(),
            )
          ).status,
        ).toBe(503);
        expect(
          (
            await manage(
              "",
              { email: "x@iqoshaven.test", name: "Sam", role: "staff" },
              ownerCookie,
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
