import { isDeepStrictEqual } from "node:util";
import {
  brandCreateRequestSchema,
  brandResponseSchema,
  brandStateRequestSchema,
  brandsQuerySchema,
  brandUpdateRequestSchema,
  defineEvent,
  type BrandCreateRequest,
  type BrandResponse,
  type BrandsQuery,
  type BrandStateRequest,
  type BrandUpdateRequest,
} from "@ih/contracts";
import type { PermissionKey } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

/**
 * Brand administration (roadmap step 42, architecture §5/§11). Every mutation runs in one
 * transaction: actor share lock + permission recheck → brand row lock → write → audit + IDs-only
 * outbox. Trash is soft and refused while live published products use the brand (publishing in
 * steps 44/51 must take the brand FOR SHARE and refuse a trashed brand). Hard purge is step 51.
 */
export class CatalogueForbiddenError extends Error {}
export class CatalogueConflictError extends Error {
  constructor(readonly reason: "VERSION_CONFLICT" | "DUPLICATE" | "TRASHED") {
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

async function canWriteSeo(tx: Database | Tx, actorId: string): Promise<boolean> {
  try {
    await lockCatalogueActor(tx, actorId, ["seo.write"], false);
    return true;
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) return false;
    throw error;
  }
}

type BrandRow = Prisma.BrandGetPayload<object> & { publishedProductCount: number };

const PUBLISHED_COUNT = Prisma.sql`(SELECT count(*)::int FROM products p
  WHERE p.brand_id=b.id AND p.status='published' AND p.deleted_at IS NULL)`;

async function loadBrand(tx: Database | Tx, id: string): Promise<BrandRow | null> {
  const brand = await tx.brand.findUnique({ where: { id } });
  if (!brand) return null;
  const [count] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT ${PUBLISHED_COUNT} AS n FROM brands b WHERE b.id=${id}::uuid`);
  return { ...brand, publishedProductCount: count?.n ?? 0 };
}

/** Stored SEO in the contract shape (`{}` and absent keys are null). */
function storedSeo(value: unknown) {
  const seo = (value ?? {}) as { title?: unknown; description?: unknown };
  return { title: seo.title ?? null, description: seo.description ?? null };
}

/**
 * SEO is always serialized here; every API route passes it through `@Serialize` with a field
 * policy that strips it for callers without `seo.write`. Never return this value unfiltered.
 */
function brandResponse(row: BrandRow): BrandResponse {
  return brandResponseSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    active: row.active,
    sortOrder: row.sortOrder,
    logoKey: row.logoKey,
    seo: storedSeo(row.seo),
    publishedProductCount: row.publishedProductCount,
    version: row.version,
    trashedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Page IDs, rows and counts are separate statements; rows may shift between them (harmless). */
export async function listBrands(db: Database, actorId: string, input: BrandsQuery) {
  const query = brandsQuerySchema.parse(input);
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const [afterOrder, afterId] = query.after ? query.after.split(/\.(.*)/s) : [];
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT b.id FROM brands b
    WHERE ${query.status === "live" ? Prisma.sql`b.deleted_at IS NULL` : Prisma.sql`b.deleted_at IS NOT NULL`}
      ${
        query.after
          ? Prisma.sql`AND (b.sort_order, b.id) > (${Number(afterOrder)}, ${afterId}::uuid)`
          : Prisma.empty
      }
    ORDER BY b.sort_order, b.id
    LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit);
  const brands = await db.brand.findMany({ where: { id: { in: page.map((row) => row.id) } } });
  const counts = page.length
    ? await db.$queryRaw<Array<{ id: string; n: number }>>(Prisma.sql`
        SELECT b.id, ${PUBLISHED_COUNT} AS n FROM brands b
        WHERE b.id IN (${Prisma.join(page.map((row) => Prisma.sql`${row.id}::uuid`))})`)
    : [];
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const countOf = new Map(counts.map((row) => [row.id, row.n]));
  const items = page.map((row) =>
    brandResponse({ ...byId.get(row.id)!, publishedProductCount: countOf.get(row.id) ?? 0 }),
  );
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > query.limit && last ? `${last.sortOrder}.${last.id}` : null,
  };
}

export async function readBrand(db: Database, actorId: string, id: string) {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const row = await loadBrand(db, id);
  if (!row) throw new CatalogueNotFoundError();
  return brandResponse(row);
}

function auditView(row: {
  name: string;
  slug: string;
  active: boolean;
  sortOrder: number;
  deletedAt: Date | null;
  version: number;
}) {
  return {
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
  action: string,
  before: ReturnType<typeof auditView> | null,
  after: ReturnType<typeof auditView>,
  id: string,
  extra: Record<string, unknown> = {},
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action,
      entity: { type: "brand", id },
      before,
      after: { ...after, ...extra },
      reveal: ["name"],
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("catalog.changed", id, { entityType: "brand", entityId: id }, after.version),
  );
}

function mapUnique(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as
      { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
    const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
    if (error.code === "P2002" || code === "23505") throw new CatalogueConflictError("DUPLICATE");
  }
  throw error;
}

async function lockBrand(tx: Tx, id: string, version: number) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM brands WHERE id=${id}::uuid FOR UPDATE`);
  const row = await loadBrand(tx, id);
  if (!row) throw new CatalogueNotFoundError();
  if (row.version !== version) throw new CatalogueConflictError("VERSION_CONFLICT");
  return row;
}

export async function createBrand(
  db: Database,
  context: CommandContext,
  input: BrandCreateRequest,
) {
  const command = brandCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      const created = await tx.brand.create({
        data: {
          name: command.name,
          slug: command.slug,
          description: command.description,
          active: command.active,
          sortOrder: command.sortOrder,
          ...(command.seo ? { seo: command.seo } : {}),
        },
      });
      await record(tx, context, "catalog.brand_created", null, auditView(created), created.id);
      return brandResponse({ ...created, publishedProductCount: 0 });
    });
  } catch (error) {
    mapUnique(error);
  }
}

export async function updateBrand(
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandUpdateRequest,
) {
  const command = brandUpdateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      const row = await lockBrand(tx, id, command.version);
      // A trashed brand is read-only until restored.
      if (row.deletedAt) throw new CatalogueConflictError("TRASHED");
      const seoChanged =
        command.seo !== undefined && !isDeepStrictEqual(storedSeo(row.seo), command.seo);
      const unchanged =
        row.name === command.name &&
        row.slug === command.slug &&
        row.description === command.description &&
        row.active === command.active &&
        row.sortOrder === command.sortOrder &&
        !seoChanged;
      if (unchanged) return brandResponse(row);
      if (row.slug !== command.slug) {
        // Reclaiming a previous slug of this brand removes its own alias first; the old slug then
        // becomes an alias for this brand (direct target, so no chains or cycles).
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM slug_redirects
          WHERE entity_type='brand' AND old_slug=${command.slug} AND brand_id=${id}::uuid`);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE brands SET name=${command.name}, slug=${command.slug},
          description=${command.description}, active=${command.active},
          sort_order=${command.sortOrder},
          seo=${seoChanged ? Prisma.sql`${JSON.stringify(command.seo)}::jsonb` : Prisma.sql`seo`},
          version=version+1, updated_at=statement_timestamp()
        WHERE id=${id}::uuid`);
      if (row.slug !== command.slug)
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO slug_redirects (entity_type, old_slug, brand_id)
          VALUES ('brand', ${row.slug}, ${id}::uuid)`);
      const updated = (await loadBrand(tx, id))!;
      await record(tx, context, "catalog.brand_updated", auditView(row), auditView(updated), id, {
        seoChanged,
      });
      return brandResponse(updated);
    });
  } catch (error) {
    mapUnique(error);
  }
}

async function changeTrash(
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
  trash: boolean,
) {
  const command = brandStateRequestSchema.parse(input);
  return withTransaction(db, async (tx) => {
    await lockCatalogueActor(tx, context.actorId, ["catalog.trash"], true);
    const row = await lockBrand(tx, id, command.version);
    if ((row.deletedAt !== null) === trash)
      throw new CatalogueConflictError(trash ? "TRASHED" : "VERSION_CONFLICT");
    if (trash && row.publishedProductCount > 0) throw new CatalogueInUseError();
    await tx.$executeRaw(Prisma.sql`
      UPDATE brands SET deleted_at=${trash ? Prisma.sql`statement_timestamp()` : Prisma.sql`NULL`},
        version=version+1, updated_at=statement_timestamp()
      WHERE id=${id}::uuid`);
    const updated = (await loadBrand(tx, id))!;
    await record(
      tx,
      context,
      trash ? "catalog.brand_trashed" : "catalog.brand_restored",
      auditView(row),
      auditView(updated),
      id,
    );
    return brandResponse(updated);
  });
}

export const trashBrand = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, context, id, input, true);
export const restoreBrand = (
  db: Database,
  context: CommandContext,
  id: string,
  input: BrandStateRequest,
) => changeTrash(db, context, id, input, false);
