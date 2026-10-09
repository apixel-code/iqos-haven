import { describe, expect, it } from "vitest";
import { assertStorageKey, MAX_PRESIGN_SECONDS, ObjectStorage } from "./storage";

const storage = new ObjectStorage({
  endpoint: "http://127.0.0.1:9",
  region: "me-central-1",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret-value",
  forcePathStyle: true,
  buckets: { quarantine: "ih-quarantine", media: "ih-media", reports: "ih-reports" },
});

describe("storage keys", () => {
  it.each(["uploads/0199c4a2/original", "reports/2026/10/sales.csv", "media/a_b-c.webp"])(
    "accepts %s",
    (key) => {
      expect(assertStorageKey(key)).toBe(key);
    },
  );
  it.each(["", "/abs", "a/../b", "a//b", "a/./b", "A/Upper", "a b", "x".repeat(600), "evil\nkey"])(
    "rejects %j",
    (key) => {
      expect(() => assertStorageKey(key)).toThrow("Invalid storage key");
    },
  );
});

describe("presigned links", () => {
  it("never outlive 15 minutes", async () => {
    await expect(
      storage.presignDownload("reports", "reports/a.csv", {
        expiresInSeconds: MAX_PRESIGN_SECONDS + 1,
      }),
    ).rejects.toThrow(RangeError);
    const url = new URL(
      await storage.presignDownload("reports", "reports/a.csv", {
        expiresInSeconds: 300,
        downloadName: 'sales "q3".csv',
      }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="sales__q3_.csv"',
    );
  });

  it("pins key, content type and a size range in upload policies", async () => {
    await expect(
      storage.presignQuarantineUpload("uploads/x/original", {
        expiresInSeconds: 60,
        maxBytes: 9 * 1024 * 1024,
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      storage.presignQuarantineUpload("media/x/original", {
        expiresInSeconds: 60,
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow("Uploads live under uploads/");
    await expect(
      storage.presignQuarantineUpload("uploads/x/original", {
        expiresInSeconds: 60,
        contentType: "image/svg+xml",
      }),
    ).rejects.toThrow(RangeError);
    const upload = await storage.presignQuarantineUpload("uploads/x/original", {
      expiresInSeconds: 60,
      contentType: "image/jpeg",
    });
    const policy = JSON.parse(Buffer.from(upload.fields.Policy!, "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ["content-length-range", 1, 8 * 1024 * 1024],
        ["eq", "$key", "uploads/x/original"],
        ["eq", "$Content-Type", "image/jpeg"],
      ]),
    );
    expect(upload.url).toContain("ih-quarantine");
  });
});
