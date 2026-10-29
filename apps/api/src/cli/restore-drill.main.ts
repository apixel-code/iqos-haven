import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { backupFacts, createDatabase, createPool } from "@ih/db";
import { backupKey, BackupIntegrityError, decryptBackup, sha256 } from "@ih/platform";
import {
  assertDrillDatabase,
  compareRestore,
  databaseTarget,
  drillDatabaseName,
  formatDrill,
  recoveryPointSeconds,
  urlForDatabase,
  type BackupManifest,
} from "./backup";
import { pgTool, repoRoot } from "./ops-process";

const usage =
  "usage: pnpm ops:restore-drill <backup-set-folder> [--keep]\n" +
  "       pnpm ops:restore-drill --drop iqos_haven_drill_<time>";

/**
 * `pnpm ops:restore-drill` (step 126, ADR 0098): restores a backup set into a new, isolated
 * database (`iqos_haven_drill_<time>`) and folder, then checks it against the manifest and
 * measures the time taken. Nothing is started on the copy (no API, worker, schedules or email
 * sends), unfinished effects are reported and never replayed, and the source database is never
 * touched. The drill database is dropped afterwards unless --keep is given.
 */
async function main(argv: string[]): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(backupEnvSchema);
  const { user } = databaseTarget(env.DATABASE_MIGRATION_URL);
  const root = resolve(repoRoot, env.BACKUP_DIR);
  const drop = async (name: string) => {
    assertDrillDatabase(name);
    await pgTool(env, [
      "psql",
      "-U",
      user,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ]);
    await rm(join(root, "drills", name), { recursive: true, force: true });
  };
  if (argv[0] === "--drop") {
    if (!argv[1]) throw new Error(usage);
    await drop(argv[1]);
    process.stdout.write(`Dropped ${argv[1]} and its drill folder.\n`);
    return 0;
  }
  if (!argv[0]) throw new Error(usage);
  const keep = argv.includes("--keep");
  const setDir = resolve(root, argv[0]);
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  const started = Date.now();
  const manifest = JSON.parse(
    await readFile(join(setDir, "manifest.json"), "utf8"),
  ) as BackupManifest;

  // Every file is checked against the manifest before anything is decrypted or restored.
  const sealed = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = await readFile(join(setDir, file.name));
    if (sha256(bytes) !== file.sha256) throw new BackupIntegrityError(file.name);
    sealed.set(file.name, bytes);
  }
  const dump = decryptBackup(key, sealed.get("database.dump.enc")!);

  const database = assertDrillDatabase(drillDatabaseName(new Date()));
  const drillDir = join(root, "drills", database);
  await mkdir(join(drillDir, "media"), { recursive: true, mode: 0o700 });
  await pgTool(env, [
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE "${database}"`,
  ]);
  let exitCode = 2;
  try {
    await pgTool(
      env,
      ["pg_restore", "-U", user, "-d", database, "--no-owner", "--exit-on-error"],
      dump,
    );
    const pool = createPool({
      connectionString: urlForDatabase(env.DATABASE_MIGRATION_URL, database),
      max: 1,
      applicationName: "ih-restore-drill",
    });
    const db = createDatabase(pool);
    const restored = await backupFacts(db).finally(async () => {
      await db.$disconnect();
      await pool.end();
    });

    // Media into the isolated drill folder: each object decrypted and checked.
    const index = JSON.parse(
      decryptBackup(key, sealed.get("media-index.enc")!).toString("utf8"),
    ) as Array<{ key: string; file: string; size: number; sha256: string }>;
    let corrupt = 0;
    for (const entry of index) {
      try {
        const body = decryptBackup(key, await readFile(join(setDir, entry.file)));
        if (sha256(body) !== entry.sha256) corrupt++;
        else
          await writeFile(join(drillDir, entry.file.replace(/\.enc$/, "")), body, { mode: 0o600 });
      } catch {
        corrupt++;
      }
    }
    const inBackup = new Set(index.map((entry) => entry.key));
    const missing = restored.mediaKeys.filter((mediaKey) => !inBackup.has(mediaKey));

    const checks = compareRestore(manifest, restored, { missing, corrupt });
    const rtoSeconds = Math.round((Date.now() - started) / 1000);
    const backupAgeSeconds = recoveryPointSeconds(manifest, new Date());
    const report = formatDrill(checks, { rtoSeconds, backupAgeSeconds, database });
    await writeFile(
      join(drillDir, "drill-report.json"),
      JSON.stringify(
        {
          set: manifest.set,
          database,
          rtoSeconds,
          backupAgeSeconds,
          checks,
          kept: keep,
          at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(report.text + "\n");
    exitCode = report.exitCode;
  } finally {
    if (!keep) {
      await drop(database);
      process.stdout.write(`Dropped ${database} and its drill folder (use --keep to inspect).\n`);
    } else
      process.stdout.write(
        `Kept ${database}; remove it with: pnpm ops:restore-drill --drop ${database}\n`,
      );
  }
  return exitCode;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : `Restore drill failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(2);
  },
);
