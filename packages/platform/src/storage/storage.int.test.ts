import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { loadEnv, loadLocalEnvFile, storageIntegrationTestEnvSchema } from "@ih/config";
import { afterAll, describe, expect, it } from "vitest";
import { ObjectStorage, storageConfigFromEnv } from "./storage";
loadLocalEnvFile();
const env = loadEnv(storageIntegrationTestEnvSchema);
const config = storageConfigFromEnv({ ...env, S3_FORCE_PATH_STYLE: true });
const storage = new ObjectStorage(config);
// Raw client with the same service credentials, to probe what the identity may NOT do.
const raw = new S3Client({
  region: config.region,
  endpoint: config.endpoint!,
  forcePathStyle: true,
  credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
});
const prefix = `test/${randomUUID()}`;
const uploadPrefix = `uploads/${randomUUID()}`;

describe("object storage (real MinIO, service identity)", () => {
  afterAll(() => {
    storage.destroy();
    raw.destroy();
  });

  it("round-trips private objects in every bucket", async () => {
    for (const purpose of ["quarantine", "media", "reports"] as const) {
      const key = `${prefix}/${purpose}.txt`;
      await storage.put(purpose, key, "hello", "text/plain");
      expect(await storage.head(purpose, key)).toEqual({ size: 5, contentType: "text/plain" });
      const object = await storage.get(purpose, key);
      expect(Buffer.from(object!.body).toString()).toBe("hello");
      await storage.delete(purpose, key);
      expect(await storage.get(purpose, key)).toBeNull();
    }
  });

  it("refuses anonymous access to objects", async () => {
    const key = `${prefix}/private.txt`;
    await storage.put("reports", key, "secret report", "text/plain");
    const response = await fetch(`${config.endpoint}/${config.buckets.reports}/${key}`);
    expect(response.status).toBe(403);
    await storage.delete("reports", key);
  });

  it("gives the service identity no bucket or policy rights", async () => {
    await expect(
      raw.send(new CreateBucketCommand({ Bucket: "ih-test-" + randomUUID().slice(0, 8) })),
    ).rejects.toMatchObject({
      name: "AccessDenied",
    });
    await expect(
      raw.send(
        new PutBucketPolicyCommand({
          Bucket: config.buckets.media,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: `arn:aws:s3:::${config.buckets.media}/*`,
              },
            ],
          }),
        }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(
      raw.send(new PutObjectCommand({ Bucket: "some-other-bucket", Key: "x", Body: "x" })),
    ).rejects.toBeDefined();
  });

  it("serves presigned downloads only until they expire", async () => {
    const key = `${prefix}/report.csv`;
    await storage.put("reports", key, "a,b\n1,2\n", "text/csv");
    const url = await storage.presignDownload("reports", key, {
      expiresInSeconds: 1,
      downloadName: "report.csv",
    });
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
    await delay(2100);
    expect((await fetch(url)).status).toBe(403);
    await storage.delete("reports", key);
  });

  it("accepts quarantine uploads only for the signed key, type and size", async () => {
    const key = `${uploadPrefix}/original`;
    const upload = await storage.presignQuarantineUpload(key, {
      expiresInSeconds: 60,
      maxBytes: 1024,
      contentType: "image/jpeg",
    });
    const post = (bytes: number, overrides: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [name, value] of Object.entries({ ...upload.fields, ...overrides }))
        form.append(name, value);
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
      return fetch(upload.url, { method: "POST", body: form });
    };
    expect((await post(2048)).status).toBe(400); // over the size range
    expect((await post(16, { key: `${uploadPrefix}/other` })).status).toBe(403); // key not covered
    expect((await post(16, { "Content-Type": "text/html" })).status).toBe(403); // type pinned
    expect((await post(512)).status).toBe(204);
    expect(await storage.head("quarantine", key)).toMatchObject({ size: 512 });
    await storage.delete("quarantine", key);
  });

  it("refuses to read an object larger than the caller's limit", async () => {
    const key = `${prefix}/big.bin`;
    await storage.put("quarantine", key, new Uint8Array(4096), "application/octet-stream");
    await expect(storage.get("quarantine", key, 1024)).rejects.toThrow(RangeError);
    await storage.delete("quarantine", key);
  });
});
