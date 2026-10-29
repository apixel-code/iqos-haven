import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { backupFacts, createDatabase, createPool, Prisma, type BackupFacts } from "@ih/db";
import {
  backupKey,
  backupSetName,
  encryptBackup,
  expiredBackupSets,
  ObjectStorage,
  sha256,
  storageConfigFromEnv,
} from "@ih/platform";
import { databaseTarget, manifestFacts, MANIFEST_VERSION, type BackupManifest } from "./backup";
import { pgTool, repoRoot } from "./ops-process";

/** Images up to this size are copied; the upload limit is 8 MB, derivatives are smaller. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/**
 * `pnpm ops:backup` (step 126, ADR 0098): one encrypted backup set of the database (pg_dump of
 * a REPEATABLE READ snapshot) and the media bucket, with a manifest of counts, totals and
 * checksums from that same snapshot. Then sets past the retention (BI-08) are removed.
 */
async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(backupEnvSchema);
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  const { user, database } = databaseTarget(env.DATABASE_MIGRATION_URL);
  const root = resolve(repoRoot, env.BACKUP_DIR);
  const started = Date.now();
  const createdAt = new Date();
  const set = backupSetName(createdAt);
  const dir = join(root, set);
  await mkdir(join(dir, "media"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const pool = createPool({
    connectionString: env.DATABASE_MIGRATION_URL,
    max: 1,
    applicationName: "ih-backup",
  });
  const db = createDatabase(pool);
  const files: BackupManifest["files"] = [];
  const save = async (name: string, plain: Uint8Array) => {
    const sealed = encryptBackup(key, plain);
    await writeFile(join(dir, name), sealed, { mode: 0o600 });
    files.push({ name, bytes: sealed.length, sha256: sha256(sealed) });
  };
  let facts: BackupFacts;
  try {
    // One read-only snapshot: the facts are read in it and pg_dump uses it, so both describe
    // the same committed moment even while orders keep arriving. No business write happens here.
    const result = await db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ snapshot: string }>>(
          Prisma.sql`SELECT pg_export_snapshot() AS snapshot`,
        );
        const inSnapshot = await backupFacts(tx);
        const dump = await pgTool(env, [
          "pg_dump",
          "-U",
          user,
          "-d",
          database,
          "--format=custom",
          `--snapshot=${row!.snapshot}`,
        ]);
        return { inSnapshot, dump };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 60 * 60_000,
        maxWait: 60_000,
      },
    );
    facts = result.inSnapshot;
    await save("database.dump.enc", result.dump);
  } finally {
    await db.$disconnect();
    await pool.end();
  }

  // Media: every object in the media bucket, each file encrypted on its own. Quarantine holds
  // unprocessed uploads only and reports are rebuilt on request, so neither is copied.
  const storage = new ObjectStorage(storageConfigFromEnv(env));
  const index: Array<{ key: string; file: string; size: number; sha256: string }> = [];
  let mediaBytes = 0;
  try {
    let next: string | undefined;
    do {
      const page = await storage.list("media", next);
      for (const object of page.objects) {
        const stored = await storage.get("media", object.key, MAX_OBJECT_BYTES);
        if (!stored) continue;
        const file = `media/${sha256(Buffer.from(object.key))}.enc`;
        await writeFile(join(dir, file), encryptBackup(key, stored.body), { mode: 0o600 });
        index.push({ key: object.key, file, size: stored.size, sha256: sha256(stored.body) });
        mediaBytes += stored.size;
      }
      next = page.next;
    } while (next);
  } finally {
    storage.destroy();
  }
  await save("media-index.enc", Buffer.from(JSON.stringify(index)));

  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    set,
    createdAt: createdAt.toISOString(),
    database,
    facts: manifestFacts(facts),
    files,
    media: { objects: index.length, bytes: mediaBytes },
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });

  // Retention: only folders named like a backup set that hold a manifest; the newest stays.
  const removed: string[] = [];
  for (const name of expiredBackupSets(
    await readdir(root),
    new Date(),
    env.BACKUP_RETENTION_DAYS,
  )) {
    const folder = join(root, name);
    if ((await stat(join(folder, "manifest.json")).catch(() => null))?.isFile()) {
      await rm(folder, { recursive: true });
      removed.push(name);
    }
  }
  process.stdout.write(
    [
      `Backup set ${set} written to ${dir}`,
      `Database ${database}: ${facts.orders} orders, ${facts.stockMovements} stock movements, migration ${facts.migrationHead ?? "unknown"}.`,
      `Media: ${index.length} objects, ${mediaBytes} bytes.`,
      `Took ${manifest.seconds} s. Retention ${env.BACKUP_RETENTION_DAYS} days; removed ${removed.length} old set(s).`,
      "Keep BACKUP_ENCRYPTION_KEY separately from this folder: without it nothing can be restored.",
    ].join("\n") + "\n",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : `Backup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(2);
  },
);
