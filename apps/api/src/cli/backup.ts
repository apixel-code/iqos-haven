import type { BackupFacts } from "@ih/db";

/**
 * Backup manifests and restore-drill checks (roadmap step 126, ADR 0098). Pure functions: the
 * CLIs gather the facts, these decide what the drill proves. A manifest holds counts, totals,
 * checksums and timestamps only, never customer data.
 */
export const MANIFEST_VERSION = 1;

export type ManifestFacts = Omit<BackupFacts, "mediaKeys"> & { mediaReferenced: number };
export interface BackupManifest {
  version: typeof MANIFEST_VERSION;
  set: string;
  /** When the snapshot the dump and the facts share was taken. */
  createdAt: string;
  database: string;
  facts: ManifestFacts;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  media: { objects: number; bytes: number };
  seconds: number;
}

export type DrillLevel = "PASS" | "WARN" | "FAIL";
export interface DrillCheck {
  level: DrillLevel;
  name: string;
  detail?: string;
}

export function manifestFacts(facts: BackupFacts): ManifestFacts {
  const { mediaKeys, ...rest } = facts;
  return { ...rest, mediaReferenced: mediaKeys.length };
}

/** The database and user a Postgres URL names (the migration role's connection). */
export function databaseTarget(url: string): { user: string; database: string } {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  if (!/^[a-z_][a-z0-9_]*$/.test(database) || !/^[a-z_][a-z0-9_]*$/.test(user))
    throw new Error("the database URL must name a plain database and user");
  return { user, database };
}

/** Drill databases are named so nothing else can ever match: `iqos_haven_drill_<UTC time>`. */
export const DRILL_DATABASE = /^iqos_haven_drill_\d{14}$/;
export function drillDatabaseName(at: Date): string {
  return "iqos_haven_drill_" + at.toISOString().replace(/\D/g, "").slice(0, 14);
}
export function assertDrillDatabase(name: string): string {
  if (!DRILL_DATABASE.test(name)) throw new Error("not a restore-drill database name");
  return name;
}

/** The same URL pointing at another database on the same server (the isolated drill copy). */
export function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/" + database;
  return parsed.toString();
}

/** RPO of this backup: how much committed business work is newer than the snapshot can be. */
export function recoveryPointSeconds(manifest: BackupManifest, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(manifest.createdAt)) / 1000));
}

/**
 * What the restored copy must match. Totals and the ledger are compared exactly; unfinished
 * effects are reported for reconciliation (never deleted, never replayed by the drill).
 */
export function compareRestore(
  manifest: BackupManifest,
  restored: BackupFacts,
  media: { missing: string[]; corrupt: number },
): DrillCheck[] {
  const want = manifest.facts;
  const checks: DrillCheck[] = [];
  const same = (name: string, expected: unknown, actual: unknown) =>
    checks.push(
      expected === actual
        ? { level: "PASS", name }
        : {
            level: "FAIL",
            name,
            detail: `expected ${String(expected)}, restored ${String(actual)}`,
          },
    );
  same("migration head matches", want.migrationHead, restored.migrationHead);
  same("order count matches", want.orders, restored.orders);
  same("order totals match (fils)", want.ordersTotalFils, restored.ordersTotalFils);
  same("collected orders match", want.collectedOrders, restored.collectedOrders);
  same("variant count matches", want.variants, restored.variants);
  same("stock on hand matches", want.stockOnHand, restored.stockOnHand);
  same("stock movements match", want.stockMovements, restored.stockMovements);
  same("coupon redemptions match", want.couponRedemptions, restored.couponRedemptions);
  checks.push(
    restored.ledgerMismatches === 0
      ? { level: "PASS", name: "every variant's stock equals its ledger" }
      : {
          level: "FAIL",
          name: "every variant's stock equals its ledger",
          detail: `${restored.ledgerMismatches} variants differ`,
        },
  );
  same(
    "unfinished effects match the backup",
    JSON.stringify(want.unfinishedEffects),
    JSON.stringify(restored.unfinishedEffects),
  );
  const unfinished = Object.values(restored.unfinishedEffects).reduce((sum, n) => sum + n, 0);
  if (unfinished)
    checks.push({
      level: "WARN",
      name: "unfinished effects to reconcile",
      detail: `${unfinished} (${Object.entries(restored.unfinishedEffects)
        .map(([status, n]) => `${status} ${n}`)
        .join(", ")}); replay only after approval, with sends enabled on purpose`,
    });
  same("referenced images match", want.mediaReferenced, restored.mediaKeys.length);
  checks.push(
    media.missing.length === 0
      ? { level: "PASS", name: "every referenced image is in the backup" }
      : {
          level: "FAIL",
          name: "every referenced image is in the backup",
          detail: `${media.missing.length} missing (first: ${media.missing[0]})`,
        },
  );
  checks.push(
    media.corrupt === 0
      ? { level: "PASS", name: "every image decrypts and matches its checksum" }
      : {
          level: "FAIL",
          name: "every image decrypts and matches its checksum",
          detail: `${media.corrupt} bad`,
        },
  );
  return checks;
}

export function formatDrill(
  checks: readonly DrillCheck[],
  measured: { rtoSeconds: number; backupAgeSeconds: number; database: string },
): { text: string; exitCode: number } {
  const lines = checks.map(
    (check) => `${check.level.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
  );
  const failed = checks.filter((check) => check.level === "FAIL").length;
  lines.push(
    "",
    `Restored into ${measured.database} (isolated; no API, worker or email sends started).`,
    `RTO (restore and verify): ${measured.rtoSeconds} s.`,
    `Backup age at restore (data newer than this is not in the copy): ${measured.backupAgeSeconds} s.`,
    failed ? `${failed} check(s) FAILED.` : "Restore drill passed.",
  );
  return { text: lines.join("\n"), exitCode: failed ? 1 : 0 };
}
