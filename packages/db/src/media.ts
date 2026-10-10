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
  productId: string;
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
    const [row] = await tx.$queryRaw<AssetRow[]>(Prisma.sql`${SELECT} WHERE id=${id}::uuid`);
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

export async function readMediaAssetForCompletion(db: Database, actorId: string, id: string) {
  await lockCatalogueActor(db, actorId, ["catalog.write", "media.upload"], false);
  const [row] = await db.$queryRaw<AssetRow[]>(Prisma.sql`${SELECT} WHERE id=${id}::uuid`);
  if (!row) throw new CatalogueNotFoundError();
  return { key: row.quarantineKey, state: row.state };
}

export async function completeMediaUpload(
  db: Database,
  context: CommandContext,
  id: string,
  observed: ObservedUpload | null,
): Promise<MediaAsset> {
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.write", "media.upload"], true);
    const [row] = await tx.$queryRaw<AssetRow[]>(
      Prisma.sql`${SELECT} WHERE id=${id}::uuid FOR UPDATE`,
    );
    if (!row) throw new CatalogueNotFoundError();
    // Completing twice is harmless: the first call already decided the outcome.
    if (row.state !== "pending") return asset(row);
    const [product] = await tx.$queryRaw<Array<{ trashed: boolean }>>(Prisma.sql`
      SELECT deleted_at IS NOT NULL AS trashed FROM products WHERE id=${row.productId}::uuid`);
    if (product?.trashed) throw new CatalogueConflictError("TRASHED");
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
    const [current] = await tx.$queryRaw<AssetRow[]>(Prisma.sql`${SELECT} WHERE id=${id}::uuid`);
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
