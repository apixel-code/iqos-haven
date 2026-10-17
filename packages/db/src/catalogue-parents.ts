import { isDeepStrictEqual } from "node:util";
import {
  brandCreateRequestSchema,
  brandResponseSchema,
  brandStateRequestSchema,
  brandsQuerySchema,
  brandUpdateRequestSchema,
  categoryCreateRequestSchema,
  categoryResponseSchema,
  categoryUpdateRequestSchema,
  defineEvent,
  type BrandCreateRequest,
  type ConflictCode,
  type BrandResponse,
  type BrandsQuery,
  type BrandStateRequest,
  type BrandUpdateRequest,
  type CategoryCreateRequest,
  type CategoryResponse,
  type CategoryUpdateRequest,
} from "@ih/contracts";
import type { PermissionKey } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

/**
 * Brand and category administration (roadmap steps 42–43, ADR 0014). Both are catalogue parents
 * with the same lifecycle: every mutation runs in one transaction — actor share lock + permission
 * recheck → parent row lock → write → audit + IDs-only `catalog.changed` outbox. Trash is soft and
 * refused while live published products use the parent; the `products_live_parents` trigger
 * refuses publishing under a trashed parent, so the two serialize. Hard purge is step 51.
 */
export class CatalogueForbiddenError extends Error {}
export class CatalogueConflictError extends Error {
  constructor(readonly reason: Exclude<ConflictCode, "IN_USE">) {
    super(reason);
  }
}
export class CatalogueNotFoundError extends Error {}
/** Refused because live published products still reference the parent. */
export class CatalogueInUseError extends Error {}

/** Locks the actor row (serializing with deactivation/role change) and checks every permission. */
export async function lockCatalogueActor(
  tx: Database | Tx,
  actorId: string | null,
  permissions: readonly PermissionKey[],
  lock: boolean,
): Promise<string> {
  if (!actorId) throw new CatalogueForbiddenError();
  const rows = await tx.$queryRaw<Array<{ held: string[] }>>(Prisma.sql`
    SELECT coalesce(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS held
    FROM (SELECT id, role_id FROM staff_users WHERE id=${actorId}::uuid AND active
          ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}) u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id
    LEFT JOIN permissions p ON p.id=rp.permission_id AND p.key IN (${Prisma.join([...permissions])})
    GROUP BY u.id`);
  const held = rows[0]?.held ?? [];
  if (!permissions.every((key) => held.includes(key))) throw new CatalogueForbiddenError();
  return actorId;
}

export async function canWriteSeo(tx: Database | Tx, actorId: string): Promise<boolean> {
  try {
    await lockCatalogueActor(tx, actorId, ["seo.write"], false);
    return true;
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) return false;
    throw error;
  }
}

type Kind = "brand" | "category";
type ResponseOf = { brand: BrandResponse; category: CategoryResponse };
type PageOf<K extends Kind> = { items: ResponseOf[K][]; nextCursor: string | null };
/** Static identifiers only (never input): table, product FK and media column per kind. */
const KINDS = {
  brand: {
    table: Prisma.raw("brands"),
    fk: Prisma.raw("brand_id"),
    media: Prisma.raw("logo_asset_id"),
    description: true,
  },
  category: {
    table: Prisma.raw("categories"),
    fk: Prisma.raw("category_id"),
    media: Prisma.raw("image_asset_id"),
    description: false,
  },
} as const;

interface ParentRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  media: string | null;
  active: boolean;
  sortOrder: number;
  seo: unknown;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  publishedProductCount: number;
}

function selectRows(kind: Kind, where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty) {
  const k = KINDS[kind];
  return Prisma.sql`
    SELECT t.id, t.name, t.slug,
      -- Categories have no description column; '' keeps one row shape (never returned for them).
      ${k.description ? Prisma.sql`t.description` : Prisma.sql`''`} AS description,
      t.${k.media} AS media, t.active, t.sort_order AS "sortOrder", t.seo, t.version,
      t.deleted_at AS "deletedAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
      (SELECT count(*)::int FROM products p
        WHERE p.${k.fk}=t.id AND p.status='published' AND p.deleted_at IS NULL)
        AS "publishedProductCount"
    FROM ${k.table} t WHERE ${where} ${tail}`;
}

async function load(tx: Database | Tx, kind: Kind, id: string): Promise<ParentRow | null> {
  const rows = await tx.$queryRaw<ParentRow[]>(selectRows(kind, Prisma.sql`t.id=${id}::uuid`));
  return rows[0] ?? null;
}

/** Stored SEO in the contract shape (`{}` and absent keys are null). */
export function storedSeo(value: unknown) {
  const seo = (value ?? {}) as { title?: unknown; description?: unknown };
  return { title: seo.title ?? null, description: seo.description ?? null };
}

/**
 * SEO is always serialized here; every API route passes it through `@Serialize` with a field
 * policy that strips it for callers without `seo.write`. Never return this value unfiltered.
 */
function response<K extends Kind>(kind: K, row: ParentRow): ResponseOf[K] {
  const common = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: row.active,
    sortOrder: row.sortOrder,
    seo: storedSeo(row.seo),
    publishedProductCount: row.publishedProductCount,
    version: row.version,
    trashedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // The one place the kind decides the shape; each branch is parsed by that kind's contract.
  return (
    kind === "brand"
      ? brandResponseSchema.parse({
          ...common,
          description: row.description,
          logoAssetId: row.media,
        })
      : categoryResponseSchema.parse({ ...common, imageAssetId: row.media })
  ) as ResponseOf[K];
}

/** Page rows and counts come from one statement; ordered by (sort order, id) keyset. */
async function list<K extends Kind>(
  db: Database,
  kind: K,
  actorId: string,
  input: BrandsQuery,
): Promise<PageOf<K>> {
  const query = brandsQuerySchema.parse(input);
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const [afterOrder, afterId] = query.after ? query.after.split(/\.(.*)/s) : [];
  const rows = await db.$queryRaw<ParentRow[]>(
    selectRows(
      kind,
      Prisma.sql`${query.status === "live" ? Prisma.sql`t.deleted_at IS NULL` : Prisma.sql`t.deleted_at IS NOT NULL`}
        ${
          query.after
            ? Prisma.sql`AND (t.sort_order, t.id) > (${Number(afterOrder)}, ${afterId}::uuid)`
            : Prisma.empty
        }`,
      Prisma.sql`ORDER BY t.sort_order, t.id LIMIT ${query.limit + 1}`,
    ),
  );
  const items = rows.slice(0, query.limit).map((row) => response(kind, row));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > query.limit && last ? `${last.sortOrder}.${last.id}` : null,
  };
}

async function read<K extends Kind>(
  db: Database,
  kind: K,
  actorId: string,
  id: string,
): Promise<ResponseOf[K]> {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const row = await load(db, kind, id);
  if (!row) throw new CatalogueNotFoundError();
  return response(kind, row);
}

function auditView(
  row: Pick<
    ParentRow,
    "name" | "slug" | "active" | "sortOrder" | "deletedAt" | "version" | "media"
  >,
) {
  return {
    image: row.media,
    name: row.name,
    slug: row.slug,
    active: row.active,
    sortOrder: row.sortOrder,
    trashed: row.deletedAt !== null,
    version: row.version,
  };
}

async function record(
  tx: Tx,
  context: CommandContext,
  kind: Kind,
  action: string,
  before: ReturnType<typeof auditView> | null,
  after: ReturnType<typeof auditView>,
  id: string,
  extra: Record<string, unknown> = {},
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: `catalog.${kind}_${action}`,
      entity: { type: kind, id },
      before,
      after: { ...after, ...extra },
      reveal: ["name"],
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("catalog.changed", id, { entityType: kind, entityId: id }, after.version),
  );
}

/** Unique violations → DUPLICATE; everything else (incl. CHECK failures) stays a loud error. */
/** The PostgreSQL error code behind a driver error, if any. */
function databaseCode(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}

export function mapCatalogueError(error: unknown): never {
  const code = databaseCode(error);
  if (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    code === "23505"
  )
    throw new CatalogueConflictError("DUPLICATE");
  // A logo or image that is not a ready catalogue image (trigger, parity G-A7), or unknown.
  if (code === "IH005" || code === "23503") throw new CatalogueConflictError("MEDIA_NOT_READY");
  throw error;
}

async function lockParent(tx: Tx, kind: Kind, id: string, version: number) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ${KINDS[kind].table} WHERE id=${id}::uuid FOR UPDATE`,
  );
  const row = await load(tx, kind, id);
  if (!row) throw new CatalogueNotFoundError();
  if (row.version !== version) throw new CatalogueConflictError("VERSION_CONFLICT");
  return row;
}

interface ParentWrite {
  name: string;
  slug: string;
  description?: string;
  active: boolean;
  sortOrder: number;
  seo?: { title: string | null; description: string | null } | undefined;
  /** The logo (brand) or image (category) asset; undefined leaves it unchanged. */
  image?: string | null | undefined;
}

/**
 * A replaced or cleared catalogue image that nothing else uses is released (parity G-A7): it
 * leaves the image picker's world, and cleanup removes its private original later.
 */
async function releaseImage(tx: Tx, assetId: string | null) {
  if (!assetId) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE media_assets SET state='removed', version=version+1, updated_at=statement_timestamp()
    WHERE id=${assetId}::uuid AND purpose='catalogue' AND state='ready'
      AND NOT EXISTS (SELECT 1 FROM brands WHERE logo_asset_id=${assetId}::uuid)
      AND NOT EXISTS (SELECT 1 FROM categories WHERE image_asset_id=${assetId}::uuid)`);
}

async function create<K extends Kind>(
  db: Database,
  kind: K,
  context: CommandContext,
  command: ParentWrite,
): Promise<ResponseOf[K]> {
  const k = KINDS[kind];
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      const [inserted] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO ${k.table} (name, slug, ${k.description ? Prisma.sql`description,` : Prisma.empty}
          active, sort_order, seo, ${k.media})
        VALUES (${command.name}, ${command.slug},
          ${k.description ? Prisma.sql`${command.description ?? ""},` : Prisma.empty}
          ${command.active}, ${command.sortOrder}, ${JSON.stringify(command.seo ?? {})}::jsonb,
          ${command.image ?? null}::uuid)
        RETURNING id`);
      const row = (await load(tx, kind, inserted!.id))!;
      await record(tx, context, kind, "created", null, auditView(row), row.id);
      return response(kind, row);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}

async function update<K extends Kind>(
  db: Database,
  kind: K,
  context: CommandContext,
  id: string,
  version: number,
  command: ParentWrite,
): Promise<ResponseOf[K]> {
  const k = KINDS[kind];
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      const row = await lockParent(tx, kind, id, version);
      // A trashed parent is read-only until restored.
      if (row.deletedAt) throw new CatalogueConflictError("TRASHED");
      // A new slug makes the old one a redirect: the Owner's (SEO and redirects, step 101).
      if (row.slug !== command.slug && !(await canWriteSeo(tx, actor)))
        throw new CatalogueForbiddenError();
      const description = k.description ? (command.description ?? "") : "";
      const seoChanged =
        command.seo !== undefined && !isDeepStrictEqual(storedSeo(row.seo), command.seo);
      const imageChanged = command.image !== undefined && command.image !== row.media;
      const unchanged =
        !imageChanged &&
        row.name === command.name &&
        row.slug === command.slug &&
        row.description === description &&
        row.active === command.active &&
        row.sortOrder === command.sortOrder &&
        !seoChanged;
      if (unchanged) return response(kind, row);
      if (row.slug !== command.slug) {
        // Reclaiming a previous slug of this parent removes its own alias first; the old slug then
        // becomes an alias for this parent (direct target, so no chains or cycles).
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM slug_redirects
          WHERE entity_type=${kind} AND old_slug=${command.slug} AND ${k.fk}=${id}::uuid`);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE ${k.table} SET name=${command.name}, slug=${command.slug},
          ${k.description ? Prisma.sql`description=${description},` : Prisma.empty}
          active=${command.active}, sort_order=${command.sortOrder},
          seo=${seoChanged ? Prisma.sql`${JSON.stringify(command.seo)}::jsonb` : Prisma.sql`seo`},
          ${k.media}=${imageChanged ? Prisma.sql`${command.image ?? null}::uuid` : Prisma.sql`${k.media}`},
          version=version+1, updated_at=statement_timestamp()
        WHERE id=${id}::uuid`);
      if (imageChanged) await releaseImage(tx, row.media);
      if (row.slug !== command.slug)
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO slug_redirects (entity_type, old_slug, ${k.fk})
          VALUES (${kind}, ${row.slug}, ${id}::uuid)`);
      const updated = (await load(tx, kind, id))!;
      await record(tx, context, kind, "updated", auditView(row), auditView(updated), id, {
        seoChanged,
        imageChanged,
      });
      return response(kind, updated);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}

async function changeTrash<K extends Kind>(
  db: Database,
  kind: K,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
  trash: boolean,
): Promise<ResponseOf[K]> {
  const command = brandStateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.trash"], true);
    const row = await lockParent(tx, kind, id, command.version);
    if ((row.deletedAt !== null) === trash)
      throw new CatalogueConflictError(trash ? "TRASHED" : "VERSION_CONFLICT");
    // Counted after the FOR UPDATE lock: a concurrent publish holds the parent FOR SHARE
    // (products_live_parents) and has either committed already or waits behind this lock.
    if (trash && row.publishedProductCount > 0) throw new CatalogueInUseError();
    await tx.$executeRaw(Prisma.sql`
      UPDATE ${KINDS[kind].table}
      SET deleted_at=${trash ? Prisma.sql`statement_timestamp()` : Prisma.sql`NULL`},
        version=version+1, updated_at=statement_timestamp()
      WHERE id=${id}::uuid`);
    const updated = (await load(tx, kind, id))!;
    await record(
      tx,
      context,
      kind,
      trash ? "trashed" : "restored",
      auditView(row),
      auditView(updated),
      id,
    );
    return response(kind, updated);
  });
}

/**
 * Owner-only permanent purge of a trashed brand or category that no product uses, trashed
 * products included (parity G-A7, ADR 0091). Its redirects go with it and its image is released
 * when nothing else uses it; the SECURITY DEFINER function is the only delete path.
 */
async function purge(
  db: Database,
  kind: Kind,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
): Promise<{ purged: true }> {
  const command = brandStateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["catalog.purge"], true);
      const row = await lockParent(tx, kind, id, command.version);
      if (!row.deletedAt) throw new CatalogueConflictError("NOT_TRASHED");
      await tx.$queryRaw(Prisma.sql`SELECT catalogue_purge_parent(${kind}, ${id}::uuid) AS image`);
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(context, {
          action: `catalog.${kind}_purged`,
          entity: { type: kind, id },
          before: auditView(row),
          after: { purged: true },
          reveal: ["name"],
        }),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("catalog.changed", id, { entityType: kind, entityId: id }, row.version + 1),
      );
      return { purged: true as const };
    });
  } catch (error) {
    const code = databaseCode(error);
    // Products (trashed ones included) still use it.
    if (code === "IH004" || code === "23503") throw new CatalogueInUseError();
    if (code === "IH003") throw new CatalogueConflictError("NOT_TRASHED");
    throw error;
  }
}

// --- Brands (step 42) ---
export const listBrands = (db: Database, actorId: string, input: BrandsQuery) =>
  list(db, "brand", actorId, input);
export const readBrand = (db: Database, actorId: string, id: string) =>
  read(db, "brand", actorId, id);
export function createBrand(db: Database, context: CommandContext, input: BrandCreateRequest) {
  const { logoAssetId, ...command } = brandCreateRequestSchema.parse(input);
  return create(db, "brand", context, { ...command, image: logoAssetId });
}
export function updateBrand(
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandUpdateRequest,
) {
  const { version, logoAssetId, ...command } = brandUpdateRequestSchema.parse(input);
  return update(db, "brand", context, id, version, { ...command, image: logoAssetId });
}
export const trashBrand = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, "brand", context, id, input, true);
export const restoreBrand = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, "brand", context, id, input, false);

export const purgeBrand = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => purge(db, "brand", context, id, input);

// --- Categories (step 43) ---
export const listCategories = (db: Database, actorId: string, input: BrandsQuery) =>
  list(db, "category", actorId, input);
export const readCategory = (db: Database, actorId: string, id: string) =>
  read(db, "category", actorId, id);
export function createCategory(
  db: Database,
  context: CommandContext,
  input: CategoryCreateRequest,
) {
  const { imageAssetId, ...command } = categoryCreateRequestSchema.parse(input);
  return create(db, "category", context, { ...command, image: imageAssetId });
}
export function updateCategory(
  db: Database,
  context: CommandContext,
  id: string,
  input: CategoryUpdateRequest,
) {
  const { version, imageAssetId, ...command } = categoryUpdateRequestSchema.parse(input);
  return update(db, "category", context, id, version, { ...command, image: imageAssetId });
}
export const trashCategory = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, "category", context, id, input, true);
export const restoreCategory = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, "category", context, id, input, false);
export const purgeCategory = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => purge(db, "category", context, id, input);
