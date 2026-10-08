import { randomUUID } from "node:crypto";
import { toAuditEntry } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditOutsideTransactionError, PrismaAuditWriter } from "./audit";
import { createDatabase, createPool, Prisma } from "./client";
import { applyMigrations } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-int-test",
});
// Identifiers are generated internally, never derived from request/config input.
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const db = createDatabase(pool, { schema: namespace });
const auditTable = Prisma.raw('"' + namespace + '"."audit_log"');
const writer = new PrismaAuditWriter();
const staffId = "0199c4a2-7b1e-7c3a-9f00-1234567890ab";
const entry = (requestId: string) =>
  toAuditEntry(
    { requestId, actorId: staffId, commandId: "cmd-" + requestId },
    {
      action: "coupon.updated",
      entity: { type: "coupon", id: "c1" },
      before: { basisPoints: 1000, secretNote: "a" },
      after: { basisPoints: 1500, secretNote: "b" },
    },
  );

describe("audit_log (real PostgreSQL)", () => {
  beforeAll(() => applyMigrations(pool, namespace));
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("appends actor/action/request/command and a redacted diff", async () => {
    await withTransaction(db, (tx) => writer.append(tx, entry("req-ok")));
    const rows = await db.auditLog.findMany({ where: { requestId: "req-ok" } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      actorType: "staff",
      actorId: staffId,
      action: "coupon.updated",
      entityType: "coupon",
      entityId: "c1",
      commandId: "cmd-req-ok",
      diff: { basisPoints: { from: 1000, to: 1500 }, secretNote: { redacted: true } },
    });
    // PostgreSQL 18 uuidv7(): version nibble 7.
    expect(row.id[14]).toBe("7");
  });

  it("rolls back with the mutation it describes", async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await writer.append(tx, entry("req-rollback"));
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect(await db.auditLog.count({ where: { requestId: "req-rollback" } })).toBe(0);
  });

  it("refuses a root client outside a transaction", async () => {
    await expect(writer.append(db as never, entry("req-root"))).rejects.toBeInstanceOf(
      AuditOutsideTransactionError,
    );
  });

  it.each([
    ["UPDATE", Prisma.sql`UPDATE ${auditTable} SET reason = 'edited'`],
    ["DELETE", Prisma.sql`DELETE FROM ${auditTable}`],
    ["TRUNCATE", Prisma.sql`TRUNCATE ${auditTable}`],
  ])("rejects %s even for the table owner", async (_name, statement) => {
    await expect(db.$executeRaw(statement)).rejects.toThrow(/append-only/);
    expect(await db.auditLog.count()).toBeGreaterThan(0);
  });

  it("revokes update/delete/truncate from the runtime role", async () => {
    const rows = await db.$queryRaw<Array<{ role: boolean; update: boolean | null }>>(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') AS role,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app')
          THEN has_table_privilege('ih_app', ${namespace + ".audit_log"}, 'UPDATE')
            OR has_table_privilege('ih_app', ${namespace + ".audit_log"}, 'DELETE')
            OR has_table_privilege('ih_app', ${namespace + ".audit_log"}, 'TRUNCATE')
        END AS update`,
    );
    if (rows[0]?.role) expect(rows[0].update).toBe(false);
  });

  it("enforces actor and action shape in the database", async () => {
    await expect(
      db.$executeRaw(
        Prisma.sql`INSERT INTO ${auditTable} (actor_type, actor_id, action, entity_type, entity_id, request_id)
          VALUES ('system', ${staffId}::uuid, 'x.y', 'x', '1', 'r')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRaw(
        Prisma.sql`INSERT INTO ${auditTable} (actor_type, action, entity_type, entity_id, request_id)
          VALUES ('system', 'Bad Action', 'x', '1', 'r')`,
      ),
    ).rejects.toThrow();
  });
});
