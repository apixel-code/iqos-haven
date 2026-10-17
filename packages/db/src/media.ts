import {
  defineEvent,
  MAX_PRODUCT_IMAGES,
  mediaAssetSchema,
  mediaUploadRequestSchema,
  type MediaAsset,
  type MediaUploadRequest,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
import {
  CatalogueConflictError,
  CatalogueNotFoundError,
  lockCatalogueActor,
} from "./catalogue-parents";

/**
 * Product media upload records (roadmap step 48, ADR 0018). Two short transactions around the
 * storage calls, never a network call inside a transaction:
 * - authorize: actor + permissions → product FOR UPDATE (serializes the eight-image limit) →
 *   pending asset with key `uploads/<asset id>` and a ten-minute authorization; the caller then
 *   signs the POST policy (local signing, no network) after commit;
 * - complete: the caller first observes the quarantine object (HEAD, outside any transaction),
 *   then the asset row is locked and moved to `uploaded` (or `rejected` when the observed bytes
 *   contradict the authorization), with audit and a `media.uploaded` event for processing.
 */
export const UPLOAD_AUTHORIZATION_SECONDS = 10 * 60;

interface AssetRow {
  id: string;
  productId: string | null;
  state: MediaAsset["state"];
  declaredType: MediaAsset["declaredType"];
  declaredBytes: number;
  observedBytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  quarantineKey: string;
  uploadExpiresAt: Date;
  expired: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Product media only: a content image (step 96) is not reachable through these routes. */
const SELECT = Prisma.sql`
  SELECT id, product_id AS "productId", state, declared_type AS "declaredType",
    declared_bytes AS "declaredBytes", observed_bytes AS "observedBytes", width, height, error,
    quarantine_key AS "quarantineKey", upload_expires_at AS "uploadExpiresAt",
    upload_expires_at <= statement_timestamp() AS expired, version,
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM media_assets`;

function asset(row: AssetRow): MediaAsset {
  return mediaAssetSchema.parse({
    id: row.id,
    productId: row.productId,
    // An authorization that ran out before completion reads as expired (cleanup marks it, 49).
    state: row.state === "pending" && row.expired ? "expired" : row.state,
    declaredType: row.declaredType,
    declaredBytes: row.declaredBytes,
    observedBytes: row.observedBytes,
    width: row.width,
    height: row.height,
    error: row.error,
    uploadExpiresAt: row.uploadExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function listProductMedia(db: Database, actorId: string, productId: string) {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const rows = await db.$queryRaw<AssetRow[]>(Prisma.sql`
    ${SELECT} WHERE product_id=${productId}::uuid ORDER BY created_at, id LIMIT 100`);
  return { items: rows.map(asset) };
}

/** Assets that still occupy one of the product's eight image slots. */
const OCCUPYING = Prisma.sql`(state IN ('uploaded','processing','ready')
  OR (state='pending' AND upload_expires_at > statement_timestamp()))`;

export async function authorizeMediaUpload(
  db: Database,
  context: CommandContext,
  productId: string,
  input: MediaUploadRequest,
): Promise<{ asset: MediaAsset; key: string }> {
  const command = mediaUploadRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    const actor = await lockCatalogueActor(
      tx,
      context.actorId,
      ["catalog.write", "media.upload"],
      true,
    );
    const [product] = await tx.$queryRaw<Array<{ trashed: boolean }>>(Prisma.sql`
      SELECT deleted_at IS NOT NULL AS trashed FROM products
      WHERE id=${productId}::uuid FOR UPDATE`);
    if (!product) throw new CatalogueNotFoundError();
    if (product.trashed) throw new CatalogueConflictError("TRASHED");
    const [count] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM media_assets
      WHERE product_id=${productId}::uuid AND ${OCCUPYING}`);
    if ((count?.n ?? 0) >= MAX_PRODUCT_IMAGES) throw new CatalogueConflictError("IMAGE_LIMIT");
    // The key embeds the asset id, so the id is drawn first (UUIDv7 from the database clock).
    const [{ id }] = (await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT uuidv7()::text AS id`,
    )) as [{ id: string }];
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
        declared_bytes, upload_expires_at)
      VALUES (${id}::uuid, ${productId}::uuid, ${actor}::uuid, ${"uploads/" + id},
        ${command.contentType}, ${command.bytes},
        statement_timestamp() + make_interval(secs => ${UPLOAD_AUTHORIZATION_SECONDS}))`);
    const [row] = await tx.$queryRaw<AssetRow[]>(
      Prisma.sql`${SELECT} WHERE id=${id}::uuid AND purpose='product'`,
    );
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "media.upload_authorized",
        entity: { type: "media_asset", id: row!.id },
        after: {
          productId,
          declaredType: command.contentType,
          declaredBytes: command.bytes,
          state: "pending",
        },
      }),
    );
    return { asset: asset(row!), key: row!.quarantineKey };
  });
}

/** What the storage HEAD reported for the quarantine object (null when absent). */
export interface ObservedUpload {
  readonly size: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
}

/** Product images need the catalogue rights; content images (step 97) the content right. */
export type MediaPurpose = "product" | "content";
const UPLOAD_PERMISSIONS = {
  product: ["catalog.write", "media.upload"],
  content: ["content.manage"],
} as const;

export async function readMediaAssetForCompletion(
  db: Database,
  actorId: string,
  id: string,
  purpose: MediaPurpose = "product",
) {
  await lockCatalogueActor(db, actorId, UPLOAD_PERMISSIONS[purpose], false);
  const [row] = await db.$queryRaw<AssetRow[]>(
    Prisma.sql`${SELECT} WHERE id=${id}::uuid AND purpose=${purpose}`,
  );
  if (!row) throw new CatalogueNotFoundError();
  return { key: row.quarantineKey, state: row.state };
}

export async function completeMediaUpload(
  db: Database,
  context: CommandContext,
  id: string,
  observed: ObservedUpload | null,
  purpose: MediaPurpose = "product",
): Promise<MediaAsset> {
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, UPLOAD_PERMISSIONS[purpose], true);
    const [row] = await tx.$queryRaw<AssetRow[]>(
      Prisma.sql`${SELECT} WHERE id=${id}::uuid AND purpose=${purpose} FOR UPDATE`,
    );
    if (!row) throw new CatalogueNotFoundError();
    // Completing twice is harmless: the first call already decided the outcome.
    if (row.state !== "pending") return asset(row);
    if (row.productId) {
      const [product] = await tx.$queryRaw<Array<{ trashed: boolean }>>(Prisma.sql`
        SELECT deleted_at IS NOT NULL AS trashed FROM products WHERE id=${row.productId}::uuid`);
      if (product?.trashed) throw new CatalogueConflictError("TRASHED");
    }
    if (row.expired) throw new CatalogueConflictError("UPLOAD_EXPIRED");
    if (!observed) throw new CatalogueConflictError("UPLOAD_MISSING");
    // The POST policy pins type and size; a contradiction means the object is not ours to trust.
    const error =
      observed.size < 1 || observed.size > row.declaredBytes
        ? "size_mismatch"
        : observed.contentType !== row.declaredType
          ? "type_mismatch"
          : null;
    const state = error ? "rejected" : "uploaded";
    await tx.$executeRaw(Prisma.sql`
      UPDATE media_assets SET state=${state}, error=${error},
        observed_bytes=${error ? null : observed.size},
        observed_type=${error ? null : (observed.contentType ?? null)},
        observed_etag=${error ? null : (observed.etag ?? null)},
        version=version+1, updated_at=statement_timestamp()
      WHERE id=${id}::uuid`);
    const [current] = await tx.$queryRaw<AssetRow[]>(
      Prisma.sql`${SELECT} WHERE id=${id}::uuid AND purpose=${purpose}`,
    );
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: error ? "media.upload_rejected" : "media.upload_completed",
        entity: { type: "media_asset", id },
        before: { state: "pending" },
        after: { state, observedBytes: observed.size, ...(error ? { error } : {}) },
      }),
    );
    if (!error)
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("media.uploaded", id, { mediaAssetId: id }, current!.version),
      );
    return asset(current!);
  });
}

/**
 * Releases a pending authorization whose POST policy could not be signed, so it does not hold
 * one of the product's eight slots until it expires.
 */
export async function abandonMediaUpload(db: Database, id: string, reason: "presign_failed") {
  await db.$executeRaw(Prisma.sql`
    UPDATE media_assets SET state='rejected', error=${reason}, version=version+1,
      updated_at=statement_timestamp()
    WHERE id=${id}::uuid AND state='pending'`);
}

// --- Content images (roadmap step 97, ADR 0065) ---
/** Uploads not yet processed that one may hold at once; finished images do not count. */
export const MAX_OPEN_CONTENT_UPLOADS = 10;

/**
 * Authorizes a content image upload (hero, campaign banners): the same quarantine, policy,
 * processing and derivatives as product images, but no product. `content.manage` only. A
 * transaction-scoped advisory lock serializes the open-upload limit.
 */
export async function authorizeContentImageUpload(
  db: Database,
  context: CommandContext,
  input: MediaUploadRequest,
): Promise<{ asset: MediaAsset; key: string }> {
  const command = mediaUploadRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    const actor = await lockCatalogueActor(tx, context.actorId, UPLOAD_PERMISSIONS.content, true);
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('ih.content_images'))`);
    const [count] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM media_assets
      WHERE purpose='content' AND (state IN ('uploaded','processing')
        OR (state='pending' AND upload_expires_at > statement_timestamp()))`);
    if ((count?.n ?? 0) >= MAX_OPEN_CONTENT_UPLOADS)
      throw new CatalogueConflictError("IMAGE_LIMIT");
    const [{ id }] = (await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT uuidv7()::text AS id`,
    )) as [{ id: string }];
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO media_assets (id, purpose, uploaded_by, quarantine_key, declared_type,
        declared_bytes, upload_expires_at)
      VALUES (${id}::uuid, 'content', ${actor}::uuid, ${"uploads/" + id},
        ${command.contentType}, ${command.bytes},
        statement_timestamp() + make_interval(secs => ${UPLOAD_AUTHORIZATION_SECONDS}))`);
    const [row] = await tx.$queryRaw<AssetRow[]>(
      Prisma.sql`${SELECT} WHERE id=${id}::uuid AND purpose='content'`,
    );
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "media.upload_authorized",
        entity: { type: "media_asset", id },
        after: {
          purpose: "content",
          declaredType: command.contentType,
          declaredBytes: command.bytes,
          state: "pending",
        },
      }),
    );
    return { asset: asset(row!), key: row!.quarantineKey };
  });
}

export interface ContentImageRow {
  id: string;
  state: MediaAsset["state"];
  width: number | null;
  height: number | null;
  error: string | null;
  derivativeKeys: Record<string, string>;
  createdAt: Date;
}
/** The newest content images, for the editor's picker; any state, so progress shows. */
export async function listContentImages(db: Database, actorId: string): Promise<ContentImageRow[]> {
  await lockCatalogueActor(db, actorId, UPLOAD_PERMISSIONS.content, false);
  return db.$queryRaw<ContentImageRow[]>(Prisma.sql`
    SELECT id, CASE WHEN state='pending' AND upload_expires_at <= statement_timestamp()
        THEN 'expired' ELSE state END AS state,
      width, height, error, derivative_keys AS "derivativeKeys", created_at AS "createdAt"
    FROM media_assets WHERE purpose='content' AND state <> 'removed'
    ORDER BY created_at DESC, id DESC LIMIT 60`);
}

// --- Processing and cleanup (step 49, ADR 0019) ---

export interface MediaForProcessing {
  readonly id: string;
  /** Null for a content image (home sections, step 96), which belongs to no product. */
  readonly productId: string | null;
  readonly state: MediaAsset["state"];
  readonly quarantineKey: string;
  readonly declaredType: MediaAsset["declaredType"];
  readonly observedEtag: string | null;
  readonly version: number;
}

export async function loadMediaForProcessing(
  db: Database,
  id: string,
): Promise<MediaForProcessing | null> {
  const [row] = await db.$queryRaw<MediaForProcessing[]>(Prisma.sql`
    SELECT id, product_id AS "productId", state, quarantine_key AS "quarantineKey",
      declared_type AS "declaredType", observed_etag AS "observedEtag", version
    FROM media_assets WHERE id=${id}::uuid`);
  return row ?? null;
}

export type MediaProcessingResult =
  | {
      readonly state: "ready";
      readonly width: number;
      readonly height: number;
      readonly sha256: string;
      readonly derivativeKeys: Readonly<Record<string, string>>;
    }
  | { readonly state: "rejected"; readonly error: string };

/**
 * Records the processing outcome once: only an `uploaded` asset changes, so a redelivered effect
 * (or a racing duplicate) is a no-op. Audit is written by the system actor in the same transaction.
 */
export async function finishMediaProcessing(
  db: Database,
  context: CommandContext,
  id: string,
  result: MediaProcessingResult,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const changed =
      result.state === "ready"
        ? await tx.$executeRaw(Prisma.sql`
            UPDATE media_assets SET state='ready', width=${result.width}, height=${result.height},
              sha256=${result.sha256}, derivative_keys=${JSON.stringify(result.derivativeKeys)}::jsonb,
              error=NULL, version=version+1, updated_at=statement_timestamp()
            WHERE id=${id}::uuid AND state='uploaded'`)
        : await tx.$executeRaw(Prisma.sql`
            UPDATE media_assets SET state='rejected', error=${result.error},
              version=version+1, updated_at=statement_timestamp()
            WHERE id=${id}::uuid AND state='uploaded'`);
    if (!changed) return false;
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: result.state === "ready" ? "media.processed" : "media.processing_rejected",
        entity: { type: "media_asset", id },
        before: { state: "uploaded" },
        after:
          result.state === "ready"
            ? { state: "ready", width: result.width, height: result.height }
            : { state: "rejected", error: result.error },
      }),
    );
    return true;
  });
}

/** Retention of private originals after successful processing. */
export const QUARANTINE_RETENTION_HOURS = 24;

/** Marks authorizations that ran out before completion as expired; returns how many. */
export async function expireMediaUploads(db: Database): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE media_assets SET state='expired', version=version+1, updated_at=statement_timestamp()
    WHERE state='pending' AND upload_expires_at <= statement_timestamp()`);
}

/**
 * Grace after an upload authorization expires before its object is deleted: storage and database
 * clocks differ, so a straggling POST could otherwise land after the purge and be orphaned.
 */
export const UPLOAD_GRACE_HOURS = 1;

/**
 * Quarantine originals that may be deleted now: expired or rejected assets once their upload
 * policy (plus grace) can no longer write, and ready assets after retention. `excluded` skips ids
 * that failed earlier in the same cleanup run.
 */
export async function mediaQuarantinePurgeCandidates(
  db: Database,
  limit: number,
  excluded: readonly string[] = [],
) {
  return db.$queryRaw<Array<{ id: string; quarantineKey: string }>>(Prisma.sql`
    SELECT id, quarantine_key AS "quarantineKey" FROM media_assets
    WHERE quarantine_purged_at IS NULL
      AND ((state IN ('expired','rejected') AND upload_expires_at <= statement_timestamp()
          - make_interval(hours => ${UPLOAD_GRACE_HOURS}))
        OR (state IN ('ready','removed') AND updated_at <= statement_timestamp()
          - make_interval(hours => ${QUARANTINE_RETENTION_HOURS})))
      ${
        excluded.length
          ? Prisma.sql`AND id NOT IN (${Prisma.join(excluded.map((id) => Prisma.sql`${id}::uuid`))})`
          : Prisma.empty
      }
    ORDER BY updated_at, id LIMIT ${limit}`);
}

/** Re-runs the step-49 backfill (idempotent); returns how many effects were created. */
export async function backfillMediaProcessing(db: Database): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ created: number }>>(
    Prisma.sql`SELECT media_backfill_processing() AS created`,
  );
  return row?.created ?? 0;
}

export async function markQuarantinePurged(db: Database, id: string) {
  await db.$executeRaw(Prisma.sql`
    UPDATE media_assets SET quarantine_purged_at=statement_timestamp()
    WHERE id=${id}::uuid AND quarantine_purged_at IS NULL`);
}
