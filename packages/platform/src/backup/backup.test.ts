import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BackupIntegrityError,
  BackupKeyError,
  backupKey,
  backupSetName,
  backupSetTime,
  decryptBackup,
  encryptBackup,
  expiredBackupSets,
  sha256,
} from "./backup";

const key = randomBytes(32);

describe("backup encryption (step 126)", () => {
  it("round-trips and uses a fresh IV per file", () => {
    const plain = Buffer.from("orders and stock");
    const a = encryptBackup(key, plain);
    const b = encryptBackup(key, plain);
    expect(decryptBackup(key, a).toString()).toBe("orders and stock");
    expect(a.equals(b)).toBe(false);
    expect(a.includes(plain)).toBe(false);
  });
  it("refuses a wrong key, an altered byte and a foreign file", () => {
    const sealed = encryptBackup(key, Buffer.from("x".repeat(64)));
    expect(() => decryptBackup(randomBytes(32), sealed)).toThrow(BackupIntegrityError);
    const altered = Buffer.from(sealed);
    altered[altered.length - 20]! ^= 1;
    expect(() => decryptBackup(key, altered)).toThrow(BackupIntegrityError);
    expect(() => decryptBackup(key, Buffer.from("plain text"))).toThrow(BackupIntegrityError);
  });
  it("accepts only a 32-byte base64url key", () => {
    expect(backupKey(randomBytes(32).toString("base64url"))).toHaveLength(32);
    expect(() => backupKey("short")).toThrow(BackupKeyError);
    expect(() => backupKey(randomBytes(32).toString("base64"))).toThrow(BackupKeyError);
  });
  it("hashes files", () => {
    expect(sha256(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("backup sets and retention (BI-08)", () => {
  it("names sets by UTC time and reads the time back", () => {
    const at = new Date("2026-10-25T08:05:09.123Z");
    expect(backupSetName(at)).toBe("ih-backup-20261025T080509Z");
    expect(backupSetTime("ih-backup-20261025T080509Z")?.toISOString()).toBe(
      "2026-10-25T08:05:09.000Z",
    );
    expect(backupSetTime("../etc")).toBeNull();
  });
  it("expires sets past the retention, never the newest, never other folders", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    const names = [
      "ih-backup-20260901T000000Z",
      "ih-backup-20260920T000000Z",
      "ih-backup-20261020T000000Z",
      "notes",
    ];
    expect(expiredBackupSets(names, now, 30)).toEqual([
      "ih-backup-20260920T000000Z",
      "ih-backup-20260901T000000Z",
    ]);
    expect(expiredBackupSets(["ih-backup-20200101T000000Z"], now, 30)).toEqual([]);
  });
});
