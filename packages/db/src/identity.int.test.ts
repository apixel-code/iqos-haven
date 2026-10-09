import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@ih/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-identity-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
// Shape only: a real hash comes from the identity service (step 28).
const ARGON = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";

async function staffRoleId(key: "owner" | "staff"): Promise<string> {
  return (await db.role.findUniqueOrThrow({ where: { key } })).id;
}

describe("identity schema and permission seeds (real PostgreSQL)", () => {
  let runtimeRole = false;
  beforeAll(async () => {
    runtimeRole =
      (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ih_app'")).rowCount === 1;
    // CI creates ih_app; a missing role there must fail rather than silently skip the checks.
    if (process.env.CI) expect(runtimeRole).toBe(true);
    await applyMigrations(pool, namespace, runtimeRole ? { runtimeRole: "ih_app" } : {});
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("seeds exactly the domain permission catalogue", async () => {
    const rows = await db.permission.findMany({ orderBy: { key: "asc" } });
    expect(Object.fromEntries(rows.map((row) => [row.key, row.description]))).toEqual(PERMISSIONS);
    expect(rows.every((row) => !row.key.includes("*"))).toBe(true);
  });

  it("grants each role exactly its explicit domain permissions", async () => {
    const roles = await db.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { key: "asc" },
    });
    expect(roles.map((role) => role.key)).toEqual(["owner", "staff"]);
    for (const role of roles) {
      const granted = role.permissions.map((grant) => grant.permission.key).sort();
      expect(granted).toEqual([...ROLE_PERMISSIONS[role.key as "owner" | "staff"]].sort());
    }
  });

  it("stores one normalized email per account and only argon2id hashes", async () => {
    const roleId = await staffRoleId("staff");
    const create = (email: string, passwordHash = ARGON) =>
      db.staffUser.create({ data: { email, passwordHash, name: "Test", roleId } });
    await create("ops@apixel.test");
    await expect(create("ops@apixel.test")).rejects.toMatchObject({ code: "P2002" });
    await expect(create("Ops@Apixel.test")).rejects.toThrow(); // must be normalized first
    await expect(create(" lead@apixel.test")).rejects.toThrow();
    await expect(create("not-an-email")).rejects.toThrow();
    await expect(create("lead@apixel.test", "plaintext-password")).rejects.toThrow();
    await expect(create("lead@apixel.test", "$2b$12$bcrypthash")).rejects.toThrow();
  });

  it("stores only 32-byte token hashes with a bounded absolute lifetime", async () => {
    const user = await db.staffUser.create({
      data: {
        email: "session@apixel.test",
        passwordHash: ARGON,
        name: "S",
        roleId: await staffRoleId("owner"),
      },
    });
    const day = 86_400_000;
    const hash = () => createHash("sha256").update(randomBytes(32)).digest();
    const session = (overrides: Record<string, unknown> = {}) =>
      db.session.create({
        data: {
          userId: user.id,
          tokenHash: hash(),
          expiresAt: new Date(Date.now() + 7 * day - 60_000),
          ...overrides,
        },
      });
    await expect(session()).resolves.toBeDefined();
    await expect(session({ tokenHash: randomBytes(16) })).rejects.toThrow();
    await expect(session({ expiresAt: new Date(Date.now() + 8 * day) })).rejects.toThrow();
    await expect(session({ revokedAt: new Date() })).rejects.toThrow(); // reason required
    await expect(
      session({ revokedAt: new Date(), revokeReason: "password_reset" }),
    ).resolves.toBeDefined();
    const duplicate = hash();
    await session({ tokenHash: duplicate });
    await expect(session({ tokenHash: duplicate })).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps roles and grants read-only and staff undeletable for the runtime role", async () => {
    if (!runtimeRole) return;
    const check = async (sql: string) =>
      (await pool.query<{ ok: boolean }>(sql, [namespace])).rows[0]!.ok;
    const table = (name: string, privilege: string) =>
      check(`SELECT has_table_privilege('ih_app', $1 || '.${name}', '${privilege}') AS ok`);
    expect(await table("roles", "SELECT")).toBe(true);
    for (const [name, privilege] of [
      ["roles", "INSERT"],
      ["roles", "UPDATE"],
      ["roles", "DELETE"],
      ["permissions", "INSERT"],
      ["permissions", "UPDATE"],
      ["role_permissions", "INSERT"],
      ["role_permissions", "DELETE"],
      ["staff_users", "DELETE"],
    ] as const)
      expect(await table(name, privilege), `${name} ${privilege}`).toBe(false);
    expect(await table("staff_users", "UPDATE")).toBe(true);
    expect(await table("sessions", "DELETE")).toBe(true);
    // The single column grant that makes the last-Owner lock possible.
    expect(
      await check(
        `SELECT has_column_privilege('ih_app', $1 || '.roles', 'created_at', 'UPDATE') AS ok`,
      ),
    ).toBe(true);
  });

  it("lets the runtime role lock the owner row but never change it", async () => {
    if (!runtimeRole) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE ih_app");
      } catch (error) {
        // Locally ih_test may not be a member of ih_app; CI (superuser) always exercises this.
        if (process.env.CI) throw error;
        await client.query("ROLLBACK");
        return;
      }
      const locked = await client.query(
        `SELECT key FROM "${namespace}".roles WHERE key = 'owner' FOR UPDATE`,
      );
      expect(locked.rows).toEqual([{ key: "owner" }]);
      await expect(
        client.query(`UPDATE "${namespace}".roles SET created_at = created_at WHERE key = 'owner'`),
      ).rejects.toThrow(/fixed launch data/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
