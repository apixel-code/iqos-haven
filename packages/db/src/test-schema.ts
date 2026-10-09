import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

/**
 * Integration tests only (exported as `@ih/db/testing`; ESLint forbids it elsewhere): applies every reviewed migration,
 * in order, into an isolated schema so tests exercise the real SQL, triggers and constraints.
 * `namespace` must be generated internally, never derived from input.
 */
export async function applyMigrations(
  pool: Pool,
  namespace: string,
  options: { runtimeRole?: string } = {},
): Promise<void> {
  if (!/^ih_test_[a-f0-9]{32}$/.test(namespace)) throw new Error("Unexpected test schema name");
  const folder = join(__dirname, "..", "prisma", "migrations");
  const migrations = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA "' + namespace + '"');
    await client.query('SET search_path TO "' + namespace + '"');
    // Mirror production: the runtime role receives default table privileges when migrations
    // create tables, so each migration's REVOKE/GRANT statements are exercised for real.
    if (options.runtimeRole === "ih_app")
      await client.query(
        'GRANT USAGE ON SCHEMA "' +
          namespace +
          '" TO ih_app; ' +
          'ALTER DEFAULT PRIVILEGES IN SCHEMA "' +
          namespace +
          '" ' +
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ih_app",
      );
    for (const name of migrations)
      await client.query(readFileSync(join(folder, name, "migration.sql"), "utf8"));
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
}
