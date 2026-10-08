import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool, pingDatabase, Prisma } from "./client";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-int-test",
});
const db = createDatabase(pool);
// Identifiers are generated internally, never derived from request/config input.
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const table = Prisma.raw('"' + namespace + '"."probe"');
describe("real PostgreSQL Prisma harness", () => {
  beforeAll(async () => {
    await pool.query('CREATE SCHEMA "' + namespace + '"');
    await pool.query('CREATE TABLE "' + namespace + '".probe (id int primary key)');
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("connects", async () => {
    expect(await pingDatabase(pool)).toBe(true);
  });
  it("uses Read Committed", async () => {
    const rows = await withTransaction(db, (tx) =>
      tx.$queryRaw<Array<{ transaction_isolation: string }>>(
        Prisma.sql`SHOW transaction_isolation`,
      ),
    );
    expect(rows[0]?.transaction_isolation).toBe("read committed");
  });
  it("rolls back the complete unit of work", async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await tx.$executeRaw(Prisma.sql`INSERT INTO ${table} (id) VALUES (${1})`);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await db.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM ${table}`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
