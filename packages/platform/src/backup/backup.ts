import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Backup files (roadmap step 126, ADR 0098): AES-256-GCM with a fresh 12-byte IV per file and
 * a versioned header, so a backup is unreadable without the separately held key and any change
 * to it is detected on restore. Whole-file in memory: sized for this store's database and media.
 */
const MAGIC = Buffer.from("IHBK1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class BackupKeyError extends Error {
  constructor() {
    super("BACKUP_ENCRYPTION_KEY must be 32 bytes, base64url encoded");
    this.name = "BackupKeyError";
  }
}
export class BackupIntegrityError extends Error {
  constructor(what: string) {
    super(`backup file failed its integrity check: ${what}`);
    this.name = "BackupIntegrityError";
  }
}

/** The key from its environment form: exactly 32 bytes, base64url. */
export function backupKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new BackupKeyError();
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new BackupKeyError();
  return key;
}

export function encryptBackup(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decryptBackup(key: Buffer, sealed: Uint8Array): Buffer {
  const data = Buffer.from(sealed);
  if (
    data.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
    !data.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new BackupIntegrityError("not an encrypted backup file");
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(MAGIC.length + IV_BYTES, data.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupIntegrityError("wrong key or altered file");
  }
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A backup set's folder name: sortable UTC time, nothing else. */
export function backupSetName(at: Date): string {
  return (
    "ih-backup-" +
    at
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
  );
}
const SET_NAME = /^ih-backup-(\d{8}T\d{6}Z)$/;
export function backupSetTime(name: string): Date | null {
  const match = SET_NAME.exec(name);
  if (!match) return null;
  const s = match[1]!;
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );
}

/**
 * Sets older than the retention (BI-08: 30 days for database backups). Only folders named like
 * a backup set are considered, and the newest set is always kept, whatever its age.
 */
export function expiredBackupSets(names: readonly string[], now: Date, days: number): string[] {
  const dated = names
    .map((name) => ({ name, at: backupSetTime(name) }))
    .filter((item): item is { name: string; at: Date } => item.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const cutoff = now.getTime() - days * 86_400_000;
  return dated
    .slice(1)
    .filter((item) => item.at.getTime() < cutoff)
    .map((item) => item.name);
}
