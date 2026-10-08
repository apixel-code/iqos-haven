import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMigrationBundle } from "./migration-policy";
describe("migration deployment safety", () => {
  it("refuses absent/truncated bundles and empty production migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-migrate-"));
    try {
      expect(() => assertMigrationBundle(dir, "production", true)).toThrow();
      writeFileSync(join(dir, "migration_lock.toml"), 'provider = "postgresql"');
      expect(() => assertMigrationBundle(dir, "production", true)).toThrow(/No reviewed/);
      expect(assertMigrationBundle(dir, "development", true)).toBe(0);
      mkdirSync(join(dir, "20261008000000_probe"));
      expect(() => assertMigrationBundle(dir, "production", false)).toThrow(/Incomplete/);
      writeFileSync(join(dir, "20261008000000_probe", "migration.sql"), "SELECT 1;");
      expect(assertMigrationBundle(dir, "production", false)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
