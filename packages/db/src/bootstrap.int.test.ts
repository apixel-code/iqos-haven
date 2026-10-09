import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { bootstrapFirstOwner, OwnerAlreadyExistsError } from "./identity";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const context = (id: string) => ({ requestId: "bootstrap-" + id, actorId: null });

async function freshSchema() {
  const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
  const pool = createPool({
    connectionString: env.DATABASE_TEST_URL,
    applicationName: "ih-bootstrap-test",
    searchPath: namespace,
  });
  await applyMigrations(pool, namespace);
  const db = createDatabase(pool, { schema: namespace });
  return {
    db,
    pool,
    async close() {
      await db.$disconnect();
      await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
      await pool.end();
    },
  };
}

describe("first-Owner bootstrap (real PostgreSQL)", () => {
  let schema: Awaited<ReturnType<typeof freshSchema>>;
  beforeAll(async () => {
    schema = await freshSchema();
  });
  afterAll(() => schema.close());

  it("creates exactly one normalized Owner with an audit entry", async () => {
    const id = await bootstrapFirstOwner(schema.db, context("1"), {
      email: "  Owner@IqosHaven.test ",
      name: "  First   Owner ",
      passwordHash: HASH,
    });
    const owner = await schema.db.staffUser.findUniqueOrThrow({
      where: { id },
      include: { role: true },
    });
    expect(owner).toMatchObject({
      email: "owner@iqoshaven.test",
      name: "First Owner",
      active: true,
    });
    expect(owner.role.key).toBe("owner");
    const audit = await schema.db.auditLog.findFirstOrThrow({
      where: { requestId: "bootstrap-1" },
    });
    expect(audit).toMatchObject({
      action: "staff.owner_bootstrapped",
      actorType: "system",
      entityId: id,
    });
    // Personal data is redacted in the audit diff.
    expect(JSON.stringify(audit.diff)).not.toContain("owner@iqoshaven.test");
  });

  it("refuses to run again, even with different details or after deactivation", async () => {
    await expect(
      bootstrapFirstOwner(schema.db, context("2"), {
        email: "second@iqoshaven.test",
        name: "X Y",
        passwordHash: HASH,
      }),
    ).rejects.toBeInstanceOf(OwnerAlreadyExistsError);
    await schema.db.staffUser.updateMany({ data: { active: false, version: { increment: 1 } } });
    await expect(
      bootstrapFirstOwner(schema.db, context("3"), {
        email: "third@iqoshaven.test",
        name: "X Y",
        passwordHash: HASH,
      }),
    ).rejects.toBeInstanceOf(OwnerAlreadyExistsError);
    expect(await schema.db.staffUser.count()).toBe(1);
  });

  it("lets exactly one of several concurrent bootstraps win", async () => {
    const other = await freshSchema();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          bootstrapFirstOwner(other.db, context("race-" + i), {
            email: `owner${i}@iqoshaven.test`,
            name: "Racing Owner",
            passwordHash: HASH,
          }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" && result.reason instanceof OwnerAlreadyExistsError,
        ),
      ).toHaveLength(4);
      expect(await other.db.staffUser.count()).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("serializes Owner writes that skip lockOwnerRole (database trigger)", async () => {
    const other = await freshSchema();
    const holder = await other.pool.connect();
    try {
      // One transaction holds the common identity guard...
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM roles WHERE key = 'owner' FOR UPDATE");
      // ...so a direct Owner insert that never calls lockOwnerRole must wait for it.
      const ownerRole = await other.db.role.findUniqueOrThrow({ where: { key: "owner" } });
      await expect(
        other.db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
          await tx.staffUser.create({
            data: {
              email: "direct@iqoshaven.test",
              name: "Direct",
              passwordHash: HASH,
              roleId: ownerRole.id,
            },
          });
        }),
      ).rejects.toThrow();
      // Non-Owner writes are not blocked by the guard.
      const staffRole = await other.db.role.findUniqueOrThrow({ where: { key: "staff" } });
      await other.db.staffUser.create({
        data: {
          email: "staff@iqoshaven.test",
          name: "Staff",
          passwordHash: HASH,
          roleId: staffRole.id,
        },
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await other.close();
    }
  });

  it("validates input before touching the database", async () => {
    const other = await freshSchema();
    try {
      await expect(
        bootstrapFirstOwner(other.db, context("bad"), {
          email: "nope",
          name: "X",
          passwordHash: HASH,
        }),
      ).rejects.toThrow("INVALID_EMAIL");
      await expect(
        bootstrapFirstOwner(other.db, context("bad2"), {
          email: "a@x.ae",
          name: "X",
          passwordHash: "plaintext",
        }),
      ).rejects.toThrow("argon2id");
      expect(await other.db.staffUser.count()).toBe(0);
    } finally {
      await other.close();
    }
  });
});
