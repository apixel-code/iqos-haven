import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import {
  backupKey,
  BackupIntegrityError,
  decryptBackup,
  ObjectStorage,
  sha256,
  storageConfigFromEnv,
} from "@ih/platform";
import type { BackupManifest } from "./backup";
import { contentTypeFor, restorableEntries, type MediaIndexEntry } from "./restore-media";
import { repoRoot } from "./ops-process";

/**
 * `pnpm ops:restore-media <set>` (real restore and server moves, ADR 0098): writes a backup
 * set's media back into the media bucket under the original keys. Every file is checked against
 * the manifest and every object against its own checksum before anything is uploaded; the set is
 * refused as a whole if any check fails. Objects already present are overwritten with the
 * verified copy. The database is restored separately (restore drill with --keep, then promote).
 */
async function main(argv: string[]): Promise<number> {
  if (!argv[0]) throw new Error("usage: pnpm ops:restore-media <backup-set-folder>");
  loadLocalEnvFile();
  const env = loadEnv(backupEnvSchema);
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  const setDir = resolve(resolve(repoRoot, env.BACKUP_DIR), argv[0]);
  const manifest = JSON.parse(
    await readFile(join(setDir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  const indexFile = manifest.files.find((file) => file.name === "media-index.enc");
  if (!indexFile) throw new BackupIntegrityError("media-index.enc");
  const sealedIndex = await readFile(join(setDir, indexFile.name));
  if (sha256(sealedIndex) !== indexFile.sha256) throw new BackupIntegrityError(indexFile.name);
  const index = JSON.parse(decryptBackup(key, sealedIndex).toString("utf8")) as MediaIndexEntry[];
  const entries = restorableEntries(index);
  if (entries.length !== index.length)
    throw new Error(`${index.length - entries.length} media index entries are not restorable`);

  // Decrypt and verify everything first: a damaged set writes nothing.
  const verified: Array<{ entry: MediaIndexEntry; body: Buffer }> = [];
  for (const entry of entries) {
    const body = decryptBackup(key, await readFile(join(setDir, entry.file)));
    if (sha256(body) !== entry.sha256 || body.length !== entry.size)
      throw new BackupIntegrityError(entry.file);
    verified.push({ entry, body });
  }
  const storage = new ObjectStorage(storageConfigFromEnv(env));
  try {
    for (const { entry, body } of verified)
      await storage.put("media", entry.key, body, contentTypeFor(entry.key));
  } finally {
    storage.destroy();
  }
  process.stdout.write(
    `Restored ${verified.length} media objects (${verified.reduce((n, v) => n + v.body.length, 0)} bytes) from ${manifest.set}.\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : `Media restore failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(2);
  },
);
