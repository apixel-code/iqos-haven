import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function assertMigrationBundle(
  folder: string,
  deployment: string,
  allowEmpty: boolean,
): number {
  const lock = join(folder, "migration_lock.toml");
  if (!existsSync(lock) || !/provider\s*=\s*"postgresql"/.test(readFileSync(lock, "utf8")))
    throw new Error("Missing or invalid migration bundle");
  const directories = readdirSync(folder, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of directories) {
    const sql = join(folder, entry.name, "migration.sql");
    if (
      !/^\d{14}_[a-z0-9_]+$/.test(entry.name) ||
      !existsSync(sql) ||
      !readFileSync(sql, "utf8").trim()
    )
      throw new Error("Incomplete migration bundle");
  }
  if (!directories.length && !(allowEmpty && deployment === "development"))
    throw new Error(
      "No reviewed migrations; deployment refused (local scaffold may pass --allow-empty)",
    );
  return directories.length;
}
