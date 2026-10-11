import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  authorizeMediaUpload,
  backfillMediaProcessing,
  completeMediaUpload,
  createDatabase,
  createPool,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { ObjectStorage, storageConfigFromEnv } from "@ih/platform";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import { createMediaCleanupJob, createMediaConsumer } from "./media";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-media-worker-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const storage = new ObjectStorage(
  storageConfigFromEnv({ ...storageEnv, S3_FORCE_PATH_STYLE: true }),
);
const log = createLogger({ service: "media-worker-test", level: "silent" });
const consumer = createMediaConsumer({ db, storage, log });
const runner = new EffectRunner({ db, owner: "media-test", log, handlers: [consumer] });
const written: Array<["quarantine" | "media", string]> = [];
let actorId = "";
let productId = "";

const jpeg = (width = 1200, height = 900) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "Private camera owner" } } })
    .toBuffer();

/** Authorize → object in quarantine → complete, as the API does (step 48). */
async function uploaded(bytes: Uint8Array, declared: "image/jpeg" | "image/png" = "image/jpeg") {
  const context = { actorId, requestId: randomUUID() };
  const { asset, key } = await authorizeMediaUpload(db, context, productId, {
    contentType: declared,
    bytes: bytes.byteLength,
  });
  await storage.put("quarantine", key, bytes, declared);
  written.push(["quarantine", key]);
  const head = await storage.head("quarantine", key);
  const completed = await completeMediaUpload(db, context, asset.id, head);
  expect(completed.state).toBe("uploaded");
  const effect = await db.consumerEffect.findFirstOrThrow({
    where: { consumer: "media_processor", event: { aggregateId: asset.id } },
  });
  return {
    id: asset.id,
    key,
    job: { eventId: effect.eventId, effectId: effect.id, consumer: "media_processor" as const },
  };
}

describe("media processing consumer and cleanup (real PostgreSQL and MinIO)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    actorId = (
      await db.staffUser.create({
        data: {
          email: "media-worker@iqoshaven.test",
          name: "Media",
          roleId: role.id,
          passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
        },
      })
    ).id;
    const brand = await db.brand.create({ data: { name: "Worker brand", slug: "worker-brand" } });
    const category = await db.category.create({
      data: { name: "Worker category", slug: "worker-category" },
    });
    productId = (
      await db.product.create({
        data: {
          name: "Worker product",
          slug: "worker-product",
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 1000n,
        },
      })
    ).id;
  });
  afterAll(async () => {
    for (const [purpose, key] of written) await storage.delete(purpose, key).catch(() => undefined);
    storage.destroy();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("validates, strips and re-encodes into private media derivatives exactly once", async () => {
    const source = await jpeg();
    const upload = await uploaded(source);
    expect(await runner.run(upload.job)).toBe("completed");
    expect(await runner.run(upload.job)).toBe("duplicate");
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: upload.id } });
    expect(asset).toMatchObject({ state: "ready", width: 1200, height: 900, error: null });
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    const keys = asset.derivativeKeys as Record<string, string>;
    expect(Object.keys(keys).sort()).toEqual(["large", "medium", "thumb"]);
    for (const key of Object.values(keys)) {
      written.push(["media", key]);
      expect(key).toMatch(
        new RegExp(`^products/${productId}/${upload.id}/(large|medium|thumb)\\.webp$`),
      );
      const object = await storage.get("media", key);
      expect(object?.contentType).toBe("image/webp");
      const meta = await sharp(Buffer.from(object!.body)).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
    }
    const audit = await db.auditLog.findMany({ where: { entityId: upload.id } });
    expect(audit.map((a) => a.action)).toContain("media.processed");
  });

  it("rejects bytes replaced after completion (ETag changed)", async () => {
    const upload = await uploaded(await jpeg(800, 800));
    await storage.put("quarantine", upload.key, await jpeg(900, 900), "image/jpeg");
    expect(await runner.run(upload.job)).toBe("completed");
    expect(await db.mediaAsset.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({
      state: "rejected",
      error: "object_changed",
    });
  });

  it("rejects disguised, malformed and undersized files without publishing anything", async () => {
    const svg = await uploaded(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
      "image/png",
    );
    const truncated = await uploaded((await jpeg()).subarray(0, 300));
    const tiny = await uploaded(await jpeg(120, 120));
    for (const upload of [svg, truncated, tiny])
      expect(await runner.run(upload.job)).toBe("completed");
    const states = await db.mediaAsset.findMany({
      where: { id: { in: [svg.id, truncated.id, tiny.id] } },
      orderBy: { id: "asc" },
    });
    expect(states.map((s) => [s.state, s.error])).toEqual([
      ["rejected", "unsupported_format"],
      ["rejected", "decode_failed"],
      ["rejected", "dimensions"],
    ]);
    for (const s of states) expect(s.derivativeKeys).toEqual({});
  });

  it("keeps a just-expired grant's object through the grace period", async () => {
    const job = createMediaCleanupJob({ db, storage, log });
    const { asset, key } = await authorizeMediaUpload(
      db,
      { actorId, requestId: randomUUID() },
      productId,
      { contentType: "image/jpeg", bytes: 10 },
    );
    await storage.put("quarantine", key, new Uint8Array(10), "image/jpeg");
    written.push(["quarantine", key]);
    await pool.query(
      "UPDATE media_assets SET upload_expires_at=statement_timestamp() - interval '1 minute' WHERE id=$1",
      [asset.id],
    );
    await job.run(new Date());
    const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.state).toBe("expired");
    expect(row.quarantinePurgedAt).toBeNull();
    expect(await storage.head("quarantine", key)).not.toBeNull();
  });

  it("backfills processing for assets completed before the consumer existed", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, state, observed_bytes, observed_etag, upload_expires_at)
       VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'uploaded', 10, 'legacy',
         statement_timestamp())`,
      [id, productId, actorId],
    );
    expect(await backfillMediaProcessing(db)).toBe(1);
    expect(await backfillMediaProcessing(db)).toBe(0);
    const effect = await db.consumerEffect.findFirstOrThrow({
      where: { consumer: "media_processor", event: { aggregateId: id } },
    });
    expect(
      await runner.run({
        eventId: effect.eventId,
        effectId: effect.id,
        consumer: "media_processor",
      }),
    ).toBe("completed");
    expect(await db.mediaAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "rejected",
      error: "object_missing",
    });
  });

  it("expires stale grants and purges quarantine originals on a durable schedule", async () => {
    const job = createMediaCleanupJob({ db, storage, log, batch: 2 });
    // A grant that ran out with an object nobody completed.
    const { asset, key } = await authorizeMediaUpload(
      db,
      { actorId, requestId: randomUUID() },
      productId,
      { contentType: "image/jpeg", bytes: 10 },
    );
    await storage.put("quarantine", key, new Uint8Array(10), "image/jpeg");
    written.push(["quarantine", key]);
    // Past expiry and the straggler grace period; earlier rejected uploads too.
    await pool.query(
      "UPDATE media_assets SET upload_expires_at=statement_timestamp() - interval '2 hours' WHERE id=$1 OR state='rejected'",
      [asset.id],
    );
    // A processed asset inside its retention window keeps its original.
    const recent = await uploaded(await jpeg(600, 600));
    expect(await runner.run(recent.job)).toBe("completed");
    await job.run(new Date());
    expect(await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({
      state: "expired",
    });
    expect(await storage.head("quarantine", key)).toBeNull();
    expect(await storage.head("quarantine", recent.key)).not.toBeNull();
    // Rejected originals from earlier tests are gone too.
    const rejected = await db.mediaAsset.findMany({ where: { state: "rejected" } });
    for (const row of rejected) {
      expect(row.quarantinePurgedAt).not.toBeNull();
      expect(await storage.head("quarantine", row.quarantineKey)).toBeNull();
    }
    // After retention the processed original is deleted; derivatives stay.
    await pool.query(
      "UPDATE media_assets SET updated_at=statement_timestamp() - interval '25 hours' WHERE id=$1",
      [recent.id],
    );
    await job.run(new Date());
    expect(await storage.head("quarantine", recent.key)).toBeNull();
    const ready = await db.mediaAsset.findUniqueOrThrow({ where: { id: recent.id } });
    expect(ready.state).toBe("ready");
    for (const key of Object.values(ready.derivativeKeys as Record<string, string>)) {
      written.push(["media", key]);
      expect(await storage.head("media", key)).not.toBeNull();
    }
    // Running again is harmless.
    await job.run(new Date());
  });
});
