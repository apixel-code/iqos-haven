import { isDeepStrictEqual } from "node:util";
import {
  defineEvent,
  productCreateRequestSchema,
  productResponseSchema,
  productsQuerySchema,
  productUpdateRequestSchema,
  type ProductCreateRequest,
  type ProductResponse,
  type ProductSort,
  type ProductsQuery,
  type ProductUpdateRequest,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";
import { assertStillPublishable } from "./publication";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  canWriteSeo,
  lockCatalogueActor,
  mapCatalogueError,
  storedSeo,
} from "./catalogue-parents";

/**
 * Product create/edit/detail/list (roadmap step 44, ADR 0015). Products are created as drafts;
 * publication and trash are step 51. Lock order (architecture §5): actor share lock → parent
 * brand then category FOR SHARE → product FOR UPDATE. The tax treatment reference is unused:
 * prices are final as entered (BI-02, ADR 0036).
 */
interface ProductRow {
  id: string;
  name: string;
  slug: string;
  brandId: string;
  brandName: string;
  categoryId: string;
  categoryName: string;
  type: "disposable" | "kit";
  puffCount: number | null;
  status: "draft" | "published";
  basePriceFils: bigint;
  compareAtPriceFils: bigint | null;
  taxTreatmentRef: string | null;
  taxTreatmentVersion: number | null;
  specs: unknown;
  description: string;
  isNew: boolean;
  seo: unknown;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = Prisma.sql`
  SELECT p.id, p.name, p.slug, p.brand_id AS "brandId", b.name AS "brandName",
    p.category_id AS "categoryId", c.name AS "categoryName", p.type, p.puff_count AS "puffCount",
    p.status, p.base_price_fils AS "basePriceFils", p.compare_at_price_fils AS "compareAtPriceFils",
    p.tax_treatment_ref AS "taxTreatmentRef", p.tax_treatment_version AS "taxTreatmentVersion",
    p.specs, p.description, p.is_new AS "isNew", p.seo, p.version, p.deleted_at AS "deletedAt",
    p.created_at AS "createdAt", p.updated_at AS "updatedAt"
  FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id`;

async function load(tx: Database | Tx, id: string): Promise<ProductRow | null> {
  const rows = await tx.$queryRaw<ProductRow[]>(Prisma.sql`${SELECT} WHERE p.id=${id}::uuid`);
  return rows[0] ?? null;
}

/** Bounded by DB CHECKs (≤ 1,000,000,000 fils), so the conversion is exact. */
const fils = (value: bigint | null) => (value === null ? null : Number(value));

/** SEO is always serialized; routes strip it via the `seo.write` field policy. */
function response(row: ProductRow): ProductResponse {
  return productResponseSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: { id: row.brandId, name: row.brandName },
    category: { id: row.categoryId, name: row.categoryName },
    type: row.type,
    puffCount: row.puffCount,
    status: row.status,
    basePriceFils: fils(row.basePriceFils),
    compareAtPriceFils: fils(row.compareAtPriceFils),
    taxTreatment:
      row.taxTreatmentRef === null
        ? null
        : { ref: row.taxTreatmentRef, version: row.taxTreatmentVersion },
    specs: row.specs,
    description: row.description,
    isNew: row.isNew,
    seo: storedSeo(row.seo),
    version: row.version,
    trashedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** `%`, `_` and `\` in a search term are matched literally. */
const like = (term: string) => "%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

/** Keyset per sort (parity G-A8): the cursor names its sort, so another sort's is refused. */
const PRODUCT_ORDER: Record<
  ProductSort,
  { key: Prisma.Sql; cast: Prisma.Sql; dir: "ASC" | "DESC" }
> = {
  newest: { key: Prisma.sql`p.id::text`, cast: Prisma.sql`text`, dir: "DESC" },
  name: { key: Prisma.sql`lower(p.name)`, cast: Prisma.sql`text`, dir: "ASC" },
  price_asc: { key: Prisma.sql`p.base_price_fils`, cast: Prisma.sql`bigint`, dir: "ASC" },
  price_desc: { key: Prisma.sql`p.base_price_fils`, cast: Prisma.sql`bigint`, dir: "DESC" },
};
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeProductCursor(value: string, sort: ProductSort): { key: string; id: string } {
  // A bare id is the cursor of before the sorts (newest first).
  if (UUID_TEXT.test(value)) {
    if (sort !== "newest") throw new ProductCursorError();
    return { key: value.toLowerCase(), id: value };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== sort ||
      typeof parsed[1] !== "string" ||
      parsed[1].length > 200 ||
      typeof parsed[2] !== "string" ||
      !UUID_TEXT.test(parsed[2]) ||
      (sort.startsWith("price") && !/^\d{1,12}$/.test(parsed[1]))
    )
      throw new Error("shape");
    return { key: parsed[1], id: parsed[2] };
  } catch {
    throw new ProductCursorError();
  }
}
/** A cursor that does not belong to the request (another sort, malformed). */
export class ProductCursorError extends Error {}

interface ProductListRow extends ProductRow {
  sortKey: string;
  onHand: number;
  stockState: "in_stock" | "low" | "out";
  thumbnailKey: string | null;
}

/**
 * The admin products list (step 44; parity G-A8): name or SKU search, stock state, four sorts.
 * Stock is computed over active options; the thumbnail is the main image's derivative key, which
 * the route signs.
 */
export async function listProducts(db: Database, actorId: string, input: ProductsQuery) {
  const query = productsQuerySchema.parse(input);
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const filters = [
    query.status === "trashed"
      ? Prisma.sql`p.deleted_at IS NOT NULL`
      : Prisma.sql`p.deleted_at IS NULL`,
  ];
  if (query.status === "draft" || query.status === "published")
    filters.push(Prisma.sql`p.status=${query.status}`);
  if (query.brandId) filters.push(Prisma.sql`p.brand_id=${query.brandId}::uuid`);
  if (query.categoryId) filters.push(Prisma.sql`p.category_id=${query.categoryId}::uuid`);
  if (query.q)
    filters.push(Prisma.sql`(p.name ILIKE ${like(query.q)}
      OR EXISTS (SELECT 1 FROM variants sv WHERE sv.product_id=p.id
        AND sv.sku ILIKE ${like(query.q)}))`);
  if (query.stock) filters.push(Prisma.sql`s.state=${query.stock}`);
  const order = PRODUCT_ORDER[query.sort];
  if (query.after) {
    const after = decodeProductCursor(query.after, query.sort);
    filters.push(
      order.dir === "DESC"
        ? Prisma.sql`(${order.key},p.id)<(${after.key}::${order.cast},${after.id}::uuid)`
        : Prisma.sql`(${order.key},p.id)>(${after.key}::${order.cast},${after.id}::uuid)`,
    );
  }
  const rows = await db.$queryRaw<ProductListRow[]>(Prisma.sql`
    SELECT x.* FROM (
      SELECT p.id, p.name, p.slug, p.brand_id AS "brandId", b.name AS "brandName",
        p.category_id AS "categoryId", c.name AS "categoryName", p.type, p.puff_count AS "puffCount",
        p.status, p.base_price_fils AS "basePriceFils", p.compare_at_price_fils AS "compareAtPriceFils",
        p.tax_treatment_ref AS "taxTreatmentRef", p.tax_treatment_version AS "taxTreatmentVersion",
        p.specs, p.description, p.is_new AS "isNew", p.seo, p.version, p.deleted_at AS "deletedAt",
        p.created_at AS "createdAt", p.updated_at AS "updatedAt",
        (${order.key})::text AS "sortKey", s.on_hand AS "onHand", s.state AS "stockState",
        (SELECT a.derivative_keys->>'thumb' FROM product_images i
          JOIN media_assets a ON a.id=i.media_asset_id
          WHERE i.product_id=p.id ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 1)
          AS "thumbnailKey"
      FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(v.stock_on_hand), 0)::int AS on_hand,
          CASE WHEN NOT coalesce(bool_or(v.stock_on_hand > 0), false) THEN 'out'
            WHEN bool_or(v.stock_on_hand <= v.low_stock_threshold) THEN 'low'
            ELSE 'in_stock' END AS state
        FROM variants v WHERE v.product_id=p.id AND v.active) s
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${order.key} ${Prisma.raw(order.dir)}, p.id ${Prisma.raw(order.dir)}
      LIMIT ${query.limit + 1}) x`);
  const page = rows.slice(0, query.limit);
  const items = page.map((row) => {
    const full = response(row);
    return {
      id: full.id,
      name: full.name,
      slug: full.slug,
      brand: full.brand,
      category: full.category,
      type: full.type,
      status: full.status,
      basePriceFils: full.basePriceFils,
      isNew: full.isNew,
      version: full.version,
      trashedAt: full.trashedAt,
      updatedAt: full.updatedAt,
      stock: { onHand: row.onHand, state: row.stockState },
      thumbnailKey: row.thumbnailKey,
    };
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify([query.sort, last.sortKey, last.id])).toString("base64url")
        : null,
  };
}

export async function readProduct(db: Database, actorId: string, id: string) {
  await lockCatalogueActor(db, actorId, ["catalog.read"], false);
  const row = await load(db, id);
  if (!row) throw new CatalogueNotFoundError();
  return response(row);
}

/** Locks brand then category FOR SHARE; true when both exist and are live. */
async function lockParents(tx: Tx, brandId: string, categoryId: string): Promise<boolean> {
  const [brand] = await tx.$queryRaw<Array<{ live: boolean }>>(Prisma.sql`
    SELECT deleted_at IS NULL AS live FROM brands WHERE id=${brandId}::uuid FOR SHARE`);
  const [category] = await tx.$queryRaw<Array<{ live: boolean }>>(Prisma.sql`
    SELECT deleted_at IS NULL AS live FROM categories WHERE id=${categoryId}::uuid FOR SHARE`);
  return Boolean(brand?.live && category?.live);
}

/** Published-state rules (step-41 CHECK) checked up front so violations are a clear 409. */
function meetsPublishedRules(command: {
  type: "disposable" | "kit";
  puffCount: number | null;
  basePriceFils: number;
}) {
  return command.basePriceFils > 0 && (command.type !== "disposable" || command.puffCount !== null);
}

function auditView(row: ProductRow) {
  return {
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    brandId: row.brandId,
    categoryId: row.categoryId,
    puffCount: row.puffCount,
    basePriceFils: fils(row.basePriceFils),
    compareAtPriceFils: fils(row.compareAtPriceFils),
    isNew: row.isNew,
    trashed: row.deletedAt !== null,
    version: row.version,
  };
}

async function record(
  tx: Tx,
  context: CommandContext,
  action: "created" | "updated",
  before: ProductRow | null,
  after: ProductRow,
  extra: Record<string, unknown> = {},
) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: `catalog.product_${action}`,
      entity: { type: "product", id: after.id },
      before: before ? auditView(before) : null,
      after: { ...auditView(after), ...extra },
      reveal: ["name"],
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent(
      "catalog.changed",
      after.id,
      { entityType: "product", entityId: after.id },
      after.version,
    ),
  );
}

export async function createProduct(
  db: Database,
  context: CommandContext,
  input: ProductCreateRequest,
) {
  const command = productCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      if (!(await lockParents(tx, command.brandId, command.categoryId)))
        throw new CatalogueConflictError("PARENT_UNAVAILABLE");
      const [inserted] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO products (name, slug, brand_id, category_id, type, puff_count,
          base_price_fils, compare_at_price_fils, specs, description, is_new, seo)
        VALUES (${command.name}, ${command.slug}, ${command.brandId}::uuid,
          ${command.categoryId}::uuid, ${command.type}, ${command.puffCount},
          ${command.basePriceFils}, ${command.compareAtPriceFils},
          ${JSON.stringify(command.specs)}::jsonb, ${command.description}, ${command.isNew},
          ${JSON.stringify(command.seo ?? {})}::jsonb)
        RETURNING id`);
      const row = (await load(tx, inserted!.id))!;
      await record(tx, context, "created", null, row);
      return response(row);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}

export async function updateProduct(
  db: Database,
  context: CommandContext,
  id: string,
  input: ProductUpdateRequest,
) {
  const { version, ...command } = productUpdateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      const actor = await lockCatalogueActor(tx, context.actorId, ["catalog.write"], true);
      if (command.seo && !(await canWriteSeo(tx, actor))) throw new CatalogueForbiddenError();
      // Parents before the product row (catalogue edits lock parents first).
      const parentsLive = await lockParents(tx, command.brandId, command.categoryId);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`);
      const row = await load(tx, id);
      if (!row) throw new CatalogueNotFoundError();
      // A new slug turns the old one into a redirect: SEO and redirect administration are the
      // Owner's (architecture §11 matrix, step 101). Creating with a slug stays catalogue work.
      if (row.slug !== command.slug && !(await canWriteSeo(tx, actor)))
        throw new CatalogueForbiddenError();
      if (row.version !== version) throw new CatalogueConflictError("VERSION_CONFLICT");
      if (row.deletedAt) throw new CatalogueConflictError("TRASHED");
      // A draft may keep a parent that was trashed later; moving to (or publishing under) an
      // unavailable parent is refused.
      const parentChanged =
        row.brandId !== command.brandId || row.categoryId !== command.categoryId;
      if (!parentsLive && (parentChanged || row.status === "published"))
        throw new CatalogueConflictError("PARENT_UNAVAILABLE");
      if (row.status === "published" && !meetsPublishedRules(command))
        throw new CatalogueConflictError("PUBLISH_REQUIREMENTS");
      const seoChanged =
        command.seo !== undefined && !isDeepStrictEqual(storedSeo(row.seo), command.seo);
      const specsChanged = !isDeepStrictEqual(row.specs, command.specs);
      const descriptionChanged = row.description !== command.description;
      const unchanged =
        row.name === command.name &&
        row.slug === command.slug &&
        row.brandId === command.brandId &&
        row.categoryId === command.categoryId &&
        row.type === command.type &&
        row.puffCount === command.puffCount &&
        fils(row.basePriceFils) === command.basePriceFils &&
        fils(row.compareAtPriceFils) === command.compareAtPriceFils &&
        row.isNew === command.isNew &&
        !specsChanged &&
        !descriptionChanged &&
        !seoChanged;
      if (unchanged) return response(row);
      if (row.slug !== command.slug)
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM slug_redirects
          WHERE entity_type='product' AND old_slug=${command.slug} AND product_id=${id}::uuid`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE products SET name=${command.name}, slug=${command.slug},
          brand_id=${command.brandId}::uuid, category_id=${command.categoryId}::uuid,
          type=${command.type}, puff_count=${command.puffCount},
          base_price_fils=${command.basePriceFils},
          compare_at_price_fils=${command.compareAtPriceFils},
          specs=${JSON.stringify(command.specs)}::jsonb, description=${command.description},
          is_new=${command.isNew},
          seo=${seoChanged ? Prisma.sql`${JSON.stringify(command.seo)}::jsonb` : Prisma.sql`seo`},
          version=version+1, updated_at=statement_timestamp()
        WHERE id=${id}::uuid`);
      if (row.slug !== command.slug)
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO slug_redirects (entity_type, old_slug, product_id)
          VALUES ('product', ${row.slug}, ${id}::uuid)`);
      await assertStillPublishable(tx, id);
      const updated = (await load(tx, id))!;
      await record(tx, context, "updated", row, updated, {
        specsChanged,
        descriptionChanged,
        seoChanged,
      });
      return response(updated);
    });
  } catch (error) {
    mapCatalogueError(error);
  }
}
