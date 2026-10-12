import {
  defineEvent,
  productReadinessSchema,
  productStateRequestSchema,
  type ProductReadiness,
  type ProductStateRequest,
  type PublishRequirement,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
import {
  CatalogueConflictError,
  CatalogueInUseError,
  CatalogueNotFoundError,
  lockCatalogueActor,
} from "./catalogue-parents";

/**
 * Product publication, trash/restore and hard purge (roadmap step 51, ADR 0021).
 * Lock order (architecture §5): actor share lock → brand then category FOR SHARE → product FOR
 * UPDATE. Variant and gallery writers also lock the product row first, so the readiness checked
 * here cannot change before commit. Zero stock never blocks publishing or unpublishes.
 */
export const MIN_DESCRIPTION_LENGTH = 20;

interface ReadinessRow {
  version: number;
  status: "draft" | "published";
  trashed: boolean;
  activeVariant: boolean;
  activeDefault: boolean;
  image: boolean;
  description: boolean;
  price: boolean;
  puffCount: boolean;
  liveParents: boolean;
}

async function readinessRow(tx: Database | Tx, productId: string) {
  const [row] = await tx.$queryRaw<ReadinessRow[]>(Prisma.sql`
    SELECT p.version, p.status, p.deleted_at IS NOT NULL AS trashed,
      EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active) AS "activeVariant",
      EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.is_default AND v.active)
        AS "activeDefault",
      EXISTS (SELECT 1 FROM product_images i WHERE i.product_id=p.id AND i.is_primary) AS image,
      length(btrim(p.description)) >= ${MIN_DESCRIPTION_LENGTH} AS description,
      (p.base_price_fils > 0 AND NOT EXISTS (
        SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active
          AND v.price_override_fils = 0)) AS price,
      (p.type <> 'disposable' OR p.puff_count IS NOT NULL) AS "puffCount",
      (b.deleted_at IS NULL AND c.deleted_at IS NULL) AS "liveParents"
    FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id
    WHERE p.id=${productId}::uuid`);
  if (!row) throw new CatalogueNotFoundError();
  const missing: PublishRequirement[] = [];
  if (row.trashed) missing.push("not_trashed");
  if (!row.activeVariant) missing.push("active_variant");
  if (!row.activeDefault) missing.push("default_variant");
  if (!row.image) missing.push("image");
  if (!row.description) missing.push("description");
  if (!row.price) missing.push("price");
  if (!row.puffCount) missing.push("puff_count");
  if (!row.liveParents) missing.push("live_brand_category");
  return { row, missing };
}

/**
 * Called inside every catalogue write that can affect readiness (product edit, variant change,
 * option change, gallery removal), after the write and under the product lock: a published
 * product must stay publishable, otherwise the whole change rolls back.
 */
export async function assertStillPublishable(tx: Tx, productId: string) {
  const { row, missing } = await readinessRow(tx, productId);
  if (row.status === "published" && missing.length)
    throw new CatalogueConflictError("PUBLISH_REQUIREMENTS");
}

export async function productReadiness(
  db: Database,
  actorId: string,
  productId: string,
): Promise<ProductReadiness> {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const { row, missing } = await readinessRow(db, productId);
  return productReadinessSchema.parse({
    productId,
    version: row.version,
    status: row.status,
    ready: missing.length === 0,
    missing,
  });
}

/**
 * Parents FOR SHARE, then the product FOR UPDATE, then the expected version. The parent ids are
 * read before any lock, so they are re-checked under the product lock: if a concurrent edit moved
 * the product meanwhile, the command conflicts instead of holding the wrong parents.
 */
async function lockForState(tx: Tx, productId: string, version: number) {
  const [ids] = await tx.$queryRaw<Array<{ brandId: string; categoryId: string }>>(Prisma.sql`
    SELECT brand_id AS "brandId", category_id AS "categoryId" FROM products
    WHERE id=${productId}::uuid`);
  if (!ids) throw new CatalogueNotFoundError();
  await tx.$queryRaw(Prisma.sql`SELECT id FROM brands WHERE id=${ids.brandId}::uuid FOR SHARE`);
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM categories WHERE id=${ids.categoryId}::uuid FOR SHARE`,
  );
  const [row] = await tx.$queryRaw<
    Array<{
      version: number;
      brandId: string;
      categoryId: string;
      status: string;
      trashed: boolean;
    }>
  >(Prisma.sql`
    SELECT version, brand_id AS "brandId", category_id AS "categoryId", status,
      deleted_at IS NOT NULL AS trashed
    FROM products WHERE id=${productId}::uuid FOR UPDATE`);
  if (!row) throw new CatalogueNotFoundError();
  if (row.brandId !== ids.brandId || row.categoryId !== ids.categoryId)
    throw new CatalogueConflictError("VERSION_CONFLICT");
  if (row.version !== version) throw new CatalogueConflictError("VERSION_CONFLICT");
  return row;
}

async function record(
  tx: Tx,
  context: CommandContext,
  productId: string,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: `catalog.product_${action}`,
      entity: { type: "product", id: productId },
      before,
      after,
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

type Command = "publish" | "unpublish" | "trash" | "restore";
const PERMISSION = {
  publish: "catalog.publish",
  unpublish: "catalog.publish",
  trash: "catalog.trash",
  restore: "catalog.trash",
} as const;

/** Publish, move to draft, trash (also unpublishes) or restore (as a draft). */
export async function changeProductState(
  db: Database,
  context: CommandContext,
  productId: string,
  command: Command,
  input: ProductStateRequest,
) {
  const { version } = productStateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, [PERMISSION[command]], true);
    const row = await lockForState(tx, productId, version);
    const before = { status: row.status, trashed: row.trashed, version: row.version };
    if (command === "publish") {
      if (row.trashed) throw new CatalogueConflictError("TRASHED");
      if (row.status === "published")
        return productReadiness(tx as unknown as Database, context.actorId!, productId);
      const { missing } = await readinessRow(tx, productId);
      if (missing.length) throw new CatalogueConflictError("PUBLISH_REQUIREMENTS");
    }
    if (command === "unpublish" && (row.trashed || row.status === "draft"))
      return productReadiness(tx as unknown as Database, context.actorId!, productId);
    if (command === "trash" && row.trashed) throw new CatalogueConflictError("TRASHED");
    if (command === "restore" && !row.trashed) throw new CatalogueConflictError("NOT_TRASHED");
    const set =
      command === "publish"
        ? Prisma.sql`status='published'`
        : command === "unpublish"
          ? Prisma.sql`status='draft'`
          : command === "trash"
            ? // Trash hides the product: it leaves the store immediately (published → draft).
              Prisma.sql`status='draft', deleted_at=statement_timestamp()`
            : Prisma.sql`deleted_at=NULL`;
    await tx.$executeRaw(Prisma.sql`
      UPDATE products SET ${set}, version=version+1, updated_at=statement_timestamp()
      WHERE id=${productId}::uuid`);
    const after = await tx.$queryRaw<Array<{ status: string; trashed: boolean; version: number }>>(
      Prisma.sql`SELECT status, deleted_at IS NOT NULL AS trashed, version FROM products
        WHERE id=${productId}::uuid`,
    );
    const past = {
      publish: "published",
      unpublish: "unpublished",
      trash: "trashed",
      restore: "restored",
    };
    await record(tx, context, productId, past[command], before, after[0]!);
    return productReadiness(tx as unknown as Database, context.actorId!, productId);
  });
}

function databaseCode(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}

/**
 * Owner-only permanent purge of a trashed product without history. Returns the private storage
 * keys to delete after commit (derivatives and unpurged originals); rows are gone atomically.
 */
export async function purgeProduct(
  db: Database,
  context: CommandContext,
  productId: string,
  input: ProductStateRequest,
): Promise<Array<{ bucket: "media" | "quarantine"; key: string }>> {
  const { version } = productStateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["catalog.purge"], true);
      const row = await lockForState(tx, productId, version);
      if (!row.trashed) throw new CatalogueConflictError("NOT_TRASHED");
      const keys = await tx.$queryRaw<Array<{ bucket: "media" | "quarantine"; key: string }>>(
        Prisma.sql`SELECT storage_bucket AS bucket, storage_key AS key
          FROM catalogue_purge_product(${productId}::uuid)`,
      );
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(context, {
          action: "catalog.product_purged",
          entity: { type: "product", id: productId },
          before: { trashed: true, version },
          after: { purged: true, storageObjects: keys.length },
        }),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent(
          "catalog.changed",
          productId,
          { entityType: "product", entityId: productId },
          version + 1,
        ),
      );
      return keys;
    });
  } catch (error) {
    const code = databaseCode(error);
    // Stock history now; order lines (RESTRICT foreign keys) once orders exist.
    if (code === "IH004" || code === "23503") throw new CatalogueInUseError();
    if (code === "IH003") throw new CatalogueConflictError("NOT_TRASHED");
    throw error;
  }
}
