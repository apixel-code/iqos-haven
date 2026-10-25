import { describe, expect, it } from "vitest";
import type { BackupFacts } from "@ih/db";
import {
  assertDrillDatabase,
  compareRestore,
  databaseTarget,
  drillDatabaseName,
  formatDrill,
  manifestFacts,
  recoveryPointSeconds,
  urlForDatabase,
  type BackupManifest,
} from "./backup";

const facts: BackupFacts = {
  migrationHead: "20261016000500_seo_policy",
  migrations: 40,
  orders: 3,
  ordersTotalFils: "19500",
  collectedOrders: 1,
  variants: 4,
  stockOnHand: 37,
  stockMovements: 9,
  ledgerMismatches: 0,
  couponRedemptions: 1,
  unfinishedEffects: { pending: 2 },
  latestWriteAt: "2026-10-25T10:00:00.000Z",
  mediaKeys: ["products/a/thumb.webp", "products/a/large.webp"],
};
const manifest: BackupManifest = {
  version: 1,
  set: "ih-backup-20261025T100500Z",
  createdAt: "2026-10-25T10:05:00.000Z",
  database: "iqos_haven",
  facts: manifestFacts(facts),
  files: [],
  media: { objects: 2, bytes: 10 },
  seconds: 3,
};

describe("restore drill checks (step 126)", () => {
  it("passes an exact restore and reports unfinished effects for reconciliation", () => {
    const checks = compareRestore(manifest, facts, { missing: [], corrupt: 0 });
    expect(checks.filter((check) => check.level === "FAIL")).toEqual([]);
    expect(checks.find((check) => check.level === "WARN")?.detail).toContain("pending 2");
    expect(
      formatDrill(checks, { rtoSeconds: 42, backupAgeSeconds: 300, database: "x" }).exitCode,
    ).toBe(0);
  });
  it("fails on any total, ledger or media difference", () => {
    const checks = compareRestore(
      manifest,
      {
        ...facts,
        ordersTotalFils: "19400",
        ledgerMismatches: 1,
        mediaKeys: ["products/a/thumb.webp"],
      },
      { missing: ["products/a/large.webp"], corrupt: 1 },
    );
    const failed = checks.filter((check) => check.level === "FAIL").map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        "order totals match (fils)",
        "every variant's stock equals its ledger",
        "referenced images match",
        "every referenced image is in the backup",
        "every image decrypts and matches its checksum",
      ]),
    );
    expect(
      formatDrill(checks, { rtoSeconds: 1, backupAgeSeconds: 1, database: "x" }).exitCode,
    ).toBe(1);
  });
  it("keeps the manifest free of keys: only how many images are referenced", () => {
    expect(manifest.facts).not.toHaveProperty("mediaKeys");
    expect(manifest.facts.mediaReferenced).toBe(2);
  });
});

describe("drill isolation (step 126)", () => {
  it("names drill databases so nothing else can match", () => {
    const name = drillDatabaseName(new Date("2026-10-25T10:05:09Z"));
    expect(name).toBe("iqos_haven_drill_20261025100509");
    expect(assertDrillDatabase(name)).toBe(name);
    for (const other of ["iqos_haven", "iqos_haven_test", "iqos_haven_drill_x; DROP"])
      expect(() => assertDrillDatabase(other)).toThrow();
  });
  it("reads the target from the migration URL and points a copy at the drill database", () => {
    const url = "postgres://ih_owner:secret@localhost:5432/iqos_haven";
    expect(databaseTarget(url)).toEqual({ user: "ih_owner", database: "iqos_haven" });
    expect(urlForDatabase(url, "iqos_haven_drill_20261025100509")).toBe(
      "postgres://ih_owner:secret@localhost:5432/iqos_haven_drill_20261025100509",
    );
    expect(() => databaseTarget("postgres://u@h/db;x")).toThrow();
  });
  it("measures how old the backup is at restore time", () => {
    expect(recoveryPointSeconds(manifest, new Date("2026-10-25T10:10:00Z"))).toBe(300);
  });
});
