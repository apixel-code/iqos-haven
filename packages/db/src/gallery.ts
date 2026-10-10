import {
  defineEvent,
  galleryAttachRequestSchema,
  galleryRemoveRequestSchema,
  galleryReorderRequestSchema,
  galleryUpdateRequestSchema,
  MAX_PRODUCT_IMAGES,
  mediaAssetSchema,
  DERIVATIVE_NAMES,
  type GalleryAttachRequest,
  type GalleryReorderRequest,
  type GalleryUpdateRequest,
  type MediaAsset,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
import {
  CatalogueConflictError,
  CatalogueNotFoundError,
  lockCatalogueActor,
} from "./catalogue-parents";

/**
 * Product image gallery (roadmap step 50, ADR 0020). Every mutation locks the actor, then the
 * product row FOR UPDATE, which serializes the cross-row rules: at most eight images, exactly one
 * primary while any exist, a dense sort order, and only `ready` assets of the same product (also
 * enforced by a DB trigger). Images reference sanitized derivative keys; callers sign short-lived
 * links for display. A removed image marks its asset `removed` (frees the slot, keeps history).
 */
export interface GalleryImageRow {
  id: string;
  mediaAssetId: string;
  isPrimary: boolean;
  sortOrder: number;
  alt: string;
  width: number;
  height: number;
  version: number;
  derivativeKeys: Record<string, string>;
}

const IMAGES = (productId: string) => Prisma.sql`
  SELECT i.id, i.media_asset_id AS "mediaAssetId", i.is_primary AS "isPrimary",
    i.sort_order AS "sortOrder", i.alt, i.width, i.height, i.version,
    m.derivative_keys AS "derivativeKeys"
  FROM product_images i JOIN media_assets m ON m.id=i.media_asset_id
  WHERE i.product_id=${productId}::uuid ORDER BY i.sort_order, i.id`;

/** Gallery rows plus uploads that are not in the gallery (state, errors) for the editor. */
export async function readProductGallery(db: Database, actorId: string, productId: string) {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  return db.$transaction(
    async (tx) => {
      const [product] = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM products WHERE id=${productId}::uuid`,
      );
      if (!product) throw new CatalogueNotFoundError();
      const images = await tx.$queryRaw<GalleryImageRow[]>(IMAGES(productId));
      const uploads = await tx.$queryRaw<
        Array<
          Omit<MediaAsset, "uploadExpiresAt" | "createdAt" | "updatedAt" | "state"> & {
            state: string;
            expired: boolean;
            uploadExpiresAt: Date;
            createdAt: Date;
            updatedAt: Date;
          }
        >
      >(Prisma.sql`
        SELECT m.id, m.product_id AS "productId", m.state, m.declared_type AS "declaredType",
          m.declared_bytes AS "declaredBytes", m.observed_bytes AS "observedBytes", m.width,
          m.height, m.error, m.upload_expires_at AS "uploadExpiresAt",
          m.upload_expires_at <= statement_timestamp() AS expired,
          m.created_at AS "createdAt", m.updated_at AS "updatedAt"
        FROM media_assets m
        WHERE m.product_id=${productId}::uuid AND m.state NOT IN ('removed','expired')
          AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.media_asset_id=m.id)
        ORDER BY m.created_at DESC, m.id DESC LIMIT 50`);
      return {
        images,
        uploads: uploads.map(({ expired, ...row }) =>
          mediaAssetSchema.parse({
            ...row,
            state: row.state === "pending" && expired ? "expired" : row.state,
            uploadExpiresAt: row.uploadExpiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }),
        ),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function lockProduct(tx: Tx, productId: string) {
  const [product] = await tx.$queryRaw<Array<{ trashed: boolean }>>(Prisma.sql`
    SELECT deleted_at IS NOT NULL AS trashed FROM products WHERE id=${productId}::uuid FOR UPDATE`);
  if (!product) throw new CatalogueNotFoundError();
  if (product.trashed) throw new CatalogueConflictError("TRASHED");
}

async function record(
  tx: Tx,
  context: CommandContext,
  productId: string,
  action: string,
  entityId: string,
  after: Record<string, unknown>,
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: `catalog.image_${action}`,
      entity: { type: "product_image", id: entityId },
      after: { productId, ...after },
    }),
  );
  const [row] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
    SELECT version FROM products WHERE id=${productId}::uuid`);
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent(
      "catalog.changed",
      productId,
      { entityType: "product", entityId: productId },
      row!.version,
    ),
  );
}

const gallery = (tx: Tx, productId: string) => tx.$queryRaw<GalleryImageRow[]>(IMAGES(productId));

export async function attachGalleryImage(
  db: Database,
  context: CommandContext,
  productId: string,
  input: GalleryAttachRequest,
) {
  const command = galleryAttachRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
    await lockProduct(tx, productId);
    const [asset] = await tx.$queryRaw<
      Array<{
        state: string;
        productId: string;
        derivativeKeys: Record<string, string>;
        width: number | null;
        height: number | null;
        attached: boolean;
      }>
    >(Prisma.sql`
      SELECT m.state, m.product_id AS "productId", m.derivative_keys AS "derivativeKeys",
        m.width, m.height,
        EXISTS (SELECT 1 FROM product_images i WHERE i.media_asset_id=m.id) AS attached
      FROM media_assets m WHERE m.id=${command.mediaAssetId}::uuid FOR UPDATE`);
    if (!asset || asset.productId !== productId) throw new CatalogueNotFoundError();
    const current = await gallery(tx, productId);
    if (asset.attached) {
      const existing = current.find((image) => image.mediaAssetId === command.mediaAssetId);
      if (existing) return gallery(tx, productId); // already attached: idempotent
    }
    // Attaching again is idempotent; a different alt on the replay is ignored (edit it instead).
    if (asset.state !== "ready" || !DERIVATIVE_NAMES.every((name) => asset.derivativeKeys[name]))
      throw new CatalogueConflictError("MEDIA_NOT_READY");
    if (current.length >= MAX_PRODUCT_IMAGES) throw new CatalogueConflictError("IMAGE_LIMIT");
    const [inserted] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO product_images (product_id, media_asset_id, asset_key, is_primary, sort_order,
        alt, width, height, mime)
      VALUES (${productId}::uuid, ${command.mediaAssetId}::uuid, ${asset.derivativeKeys.large},
        ${current.length === 0}, ${current.length}, ${command.alt}, ${asset.width},
        ${asset.height}, 'image/webp')
      RETURNING id`);
    await record(tx, context, productId, "attached", inserted!.id, {
      mediaAssetId: command.mediaAssetId,
      isPrimary: current.length === 0,
      sortOrder: current.length,
    });
    return gallery(tx, productId);
  });
}

export async function updateGalleryImage(
  db: Database,
  context: CommandContext,
  productId: string,
  imageId: string,
  input: GalleryUpdateRequest,
) {
  const command = galleryUpdateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
    await lockProduct(tx, productId);
    const current = await gallery(tx, productId);
    const image = current.find((row) => row.id === imageId);
    if (!image) throw new CatalogueNotFoundError();
    if (image.version !== command.version) throw new CatalogueConflictError("VERSION_CONFLICT");
    if (image.isPrimary && !command.isPrimary) throw new CatalogueConflictError("DEFAULT_REQUIRED");
    if (image.alt === command.alt && image.isPrimary === command.isPrimary)
      return gallery(tx, productId);
    if (command.isPrimary && !image.isPrimary)
      await tx.$executeRaw(Prisma.sql`
        UPDATE product_images SET is_primary=false, version=version+1,
          updated_at=statement_timestamp()
        WHERE product_id=${productId}::uuid AND is_primary`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE product_images SET alt=${command.alt}, is_primary=${command.isPrimary},
        version=version+1, updated_at=statement_timestamp()
      WHERE id=${imageId}::uuid`);
    await record(tx, context, productId, "updated", imageId, {
      isPrimary: command.isPrimary,
      altChanged: image.alt !== command.alt,
    });
    return gallery(tx, productId);
  });
}

export async function reorderGalleryImages(
  db: Database,
  context: CommandContext,
  productId: string,
  input: GalleryReorderRequest,
) {
  const command = galleryReorderRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
    await lockProduct(tx, productId);
    const current = await gallery(tx, productId);
    const ids = current.map((row) => row.id);
    if (ids.length !== command.imageIds.length || !command.imageIds.every((id) => ids.includes(id)))
      throw new CatalogueConflictError("ORDER_MISMATCH");
    if (command.imageIds.every((id, index) => ids[index] === id)) return gallery(tx, productId);
    for (const [index, id] of command.imageIds.entries())
      await tx.$executeRaw(Prisma.sql`
        UPDATE product_images SET sort_order=${index}, version=version+1,
          updated_at=statement_timestamp()
        WHERE id=${id}::uuid AND sort_order<>${index}`);
    await record(tx, context, productId, "reordered", productId, { order: command.imageIds });
    return gallery(tx, productId);
  });
}

export async function removeGalleryImage(
  db: Database,
  context: CommandContext,
  productId: string,
  imageId: string,
  input: { version: number },
) {
  const command = galleryRemoveRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
    await lockProduct(tx, productId);
    const current = await gallery(tx, productId);
    const image = current.find((row) => row.id === imageId);
    if (!image) throw new CatalogueNotFoundError();
    if (image.version !== command.version) throw new CatalogueConflictError("VERSION_CONFLICT");
    await tx.$executeRaw(Prisma.sql`DELETE FROM product_images WHERE id=${imageId}::uuid`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE media_assets SET state='removed', version=version+1, updated_at=statement_timestamp()
      WHERE id=${image.mediaAssetId}::uuid AND state='ready'`);
    // Keep the order dense and, if the primary went, promote the next image.
    const rest = current.filter((row) => row.id !== imageId);
    for (const [index, row] of rest.entries()) {
      const primary = image.isPrimary ? index === 0 : row.isPrimary;
      if (row.sortOrder !== index || row.isPrimary !== primary)
        await tx.$executeRaw(Prisma.sql`
          UPDATE product_images SET sort_order=${index}, is_primary=${primary},
            version=version+1, updated_at=statement_timestamp()
          WHERE id=${row.id}::uuid`);
    }
    await record(tx, context, productId, "removed", imageId, {
      mediaAssetId: image.mediaAssetId,
      wasPrimary: image.isPrimary,
    });
    return gallery(tx, productId);
  });
}
