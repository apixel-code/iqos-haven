import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { bootstrapFirstOwner } from "./identity";
import { recoverOwnerAccess, OwnerRecoveryRefusedError } from "./owner-recovery";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const OLD = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$b2xkb2xkb2xkb2xk";
const NEW = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$bmV3bmV3bmV3bmV3";
const context = (id: string) => ({ requestId: "recovery-" + id, actorId: null });

describe("break-glass Owner recovery (step 127, real PostgreSQL)", () => {
  const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
  const pool = createPool({
    connectionString: env.DATABASE_TEST_URL,
    applicationName: "ih-owner-recovery-test",
    searchPath: namespace,
  });
  let db: ReturnType<typeof createDatabase>;
  let ownerId: string;
  let staffId: string;
  const session = (userId: string) =>
    db.session.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    db = createDatabase(pool, { schema: namespace });
    ownerId = await bootstrapFirstOwner(db, context("boot"), {
      email: "owner@iqoshaven.test",
      name: "First Owner",
      passwordHash: OLD,
    });
    const staffRole = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    staffId = (
      await db.staffUser.create({
        data: {
          email: "staff@iqoshaven.test",
          name: "Staff Member",
          passwordHash: OLD,
          roleId: staffRole.id,
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses a non-Owner account and leaves it unchanged", async () => {
    await expect(
      recoverOwnerAccess(db, context("short"), {
        email: "owner@iqoshaven.test",
        passwordHash: NEW,
        reason: "INC-1",
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      recoverOwnerAccess(db, context("staff"), {
        email: "staff@iqoshaven.test",
        passwordHash: NEW,
        reason: "INC-1 lost access",
      }),
    ).rejects.toMatchObject({ code: "OWNER_RECOVERY_NOT_OWNER" });
    await expect(
      recoverOwnerAccess(db, context("none"), {
        email: "nobody@iqoshaven.test",
        passwordHash: NEW,
        reason: "INC-1 unknown account",
      }),
    ).rejects.toBeInstanceOf(OwnerRecoveryRefusedError);
    const staff = await db.staffUser.findUniqueOrThrow({ where: { id: staffId } });
    expect(staff).toMatchObject({ passwordHash: OLD, version: 1 });
  });

  it("restores a deactivated sole Owner: new password, sessions and links revoked, audited", async () => {
    await session(ownerId);
    await session(ownerId);
    // The only Owner was switched off by tooling or a compromised session: nobody can sign in.
    await pool.query(`UPDATE "${namespace}".staff_users SET active = false WHERE id = $1`, [
      ownerId,
    ]);
    const result = await recoverOwnerAccess(db, context("ok"), {
      email: " Owner@IqosHaven.test ",
      passwordHash: NEW,
      reason: "INC-2 sole Owner locked out",
    });
    expect(result).toEqual({
      id: ownerId,
      reactivated: true,
      sessionsRevoked: 2,
      otherActiveOwners: 0,
    });
    const owner = await db.staffUser.findUniqueOrThrow({
      where: { id: ownerId },
      include: { role: true },
    });
    expect(owner).toMatchObject({ active: true, passwordHash: NEW, version: 2 });
    expect(owner.role.key).toBe("owner");
    expect(
      await db.session.count({ where: { userId: ownerId, revokeReason: "owner_recovered" } }),
    ).toBe(2);
    expect(await db.session.count({ where: { userId: ownerId, revokedAt: null } })).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ where: { requestId: "recovery-ok" } });
    expect(audit).toMatchObject({
      action: "staff.owner_recovered",
      actorType: "system",
      entityId: ownerId,
    });
    expect(JSON.stringify(audit)).not.toContain(NEW);
    const events = await db.outboxEvent.findMany({
      where: { aggregateId: ownerId },
      select: { eventType: true },
    });
    expect(events.map((event) => event.eventType).sort()).toEqual([
      "staff.password_reset",
      "staff.reactivated",
    ]);
  });

  it("refuses while another Owner is active unless that Owner is declared untrusted", async () => {
    const ownerRole = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    await db.staffUser.update({ where: { id: staffId }, data: { roleId: ownerRole.id } });
    await expect(
      recoverOwnerAccess(db, context("busy"), {
        email: "owner@iqoshaven.test",
        passwordHash: OLD,
        reason: "INC-3 other Owner active",
      }),
    ).rejects.toMatchObject({ code: "OWNER_RECOVERY_ACTIVE_OWNER" });
    const result = await recoverOwnerAccess(db, context("override"), {
      email: "owner@iqoshaven.test",
      passwordHash: OLD,
      reason: "INC-3 other Owner account compromised",
      despiteActiveOwner: true,
    });
    expect(result).toMatchObject({ reactivated: false, otherActiveOwners: 1 });
  });
});
