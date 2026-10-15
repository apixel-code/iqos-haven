import {
  storeProductsQuerySchema,
  type StoreProductSort,
  type StoreProductsQuery,
  type StoreRating,
  type StoreReview,
} from "@ih/contracts";
import { productAvailability } from "@ih/domain";
import { Prisma, type Database } from "./client";
import { readProductReviews } from "./reviews";

/**
 * Shopper catalogue reads (roadmap step 58). Read-only and the single definition of what a
 * shopper may see:
 * - a product is visible when it is published, not trashed, and both its brand and its category
 *   are active and not trashed;
 * - only active variants are options; a product with none is not visible;
 * - a brand or category is visible when it is active and not trashed.
 * Zero stock never hides anything: it only marks an option or product unavailable.
 * Callers authorize (age ticket) before calling; nothing here checks the caller.
 */
export const VISIBLE_PRODUCT = Prisma.sql`
  p.status='published' AND p.deleted_at IS NULL
  AND b.active AND b.deleted_at IS NULL
  AND c.active AND c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active)`;
export const PRODUCT_FROM = Prisma.sql`
  FROM products p
  JOIN brands b ON b.id=p.brand_id
  JOIN categories c ON c.id=p.category_id`;

export interface StoreParentRow {
  name: string;
  slug: string;
  description?: string;
  productCount: number;
}

export async function listStoreBrands(db: Database): Promise<StoreParentRow[]> {
  return db.$queryRaw<StoreParentRow[]>(Prisma.sql`
    SELECT x.name, x.slug, x.description,
      (SELECT count(*)::int ${PRODUCT_FROM} WHERE p.brand_id=x.id AND ${VISIBLE_PRODUCT})
        AS "productCount"
    FROM brands x WHERE x.active AND x.deleted_at IS NULL
    ORDER BY x.sort_order, lower(x.name), x.id LIMIT 500`);
}

export async function listStoreCategories(db: Database): Promise<StoreParentRow[]> {
  return db.$queryRaw<StoreParentRow[]>(Prisma.sql`
    SELECT x.name, x.slug,
      (SELECT count(*)::int ${PRODUCT_FROM} WHERE p.category_id=x.id AND ${VISIBLE_PRODUCT})
        AS "productCount"
    FROM categories x WHERE x.active AND x.deleted_at IS NULL
    ORDER BY x.sort_order, lower(x.name), x.id LIMIT 500`);
}

export interface StoreImageRow {
  alt: string;
  width: number;
  height: number;
  derivativeKeys: Record<string, string>;
}
export interface StoreProductCardRow {
  id: string;
  slug: string;
  name: string;
  type: "disposable" | "kit";
  brandName: string;
  brandSlug: string;
  categoryName: string;
  categorySlug: string;
  puffCount: number | null;
  isNew: boolean;
  priceFromFils: number;
  compareAtPriceFils: number | null;
  variantCount: number;
  soldOut: boolean;
  image: StoreImageRow | null;
}

/** Thrown for a cursor that was not issued for this sort (the API answers 400). */
export class StoreCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Position<S extends string = StoreProductSort> = {
  sort: S;
  key: string | number;
  id: string;
};

export function encodeCursor(position: Position<string>): string {
  return Buffer.from(JSON.stringify([position.sort, position.key, position.id])).toString(
    "base64url",
  );
}
/** Highest price a column can hold (CHECK on the fils columns); also the cursor bound. */
const MAX_FILS = 1_000_000_000;

/**
 * Validates a cursor for a sort without touching the database. Everything a decoded cursor
 * carries is bounded to what the columns can hold, so a forged one is a 400, never a query error.
 */
export function assertStoreCursor(cursor: string, sort: StoreProductSort): void {
  decodeCursor(cursor, sort);
}

/** `numericMax`: the key is an integer in [0, numericMax]; without it the key is bounded text. */
export function decodeCursor<S extends string>(
  cursor: string,
  sort: S,
  numericMax: number | null = sort === "price_asc" || sort === "price_desc" ? MAX_FILS : null,
): Position<S> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new StoreCursorError();
  }
  if (!Array.isArray(value) || value.length !== 3) throw new StoreCursorError();
  const [cursorSort, key, id] = value as unknown[];
  if (cursorSort !== sort || typeof id !== "string" || !UUID.test(id)) throw new StoreCursorError();
  if (numericMax !== null) {
    if (!Number.isInteger(key) || (key as number) < 0 || (key as number) > numericMax)
      throw new StoreCursorError();
  } else if (
    typeof key !== "string" ||
    key.length > 200 ||
    // PostgreSQL text cannot hold NUL; no issued cursor contains control characters.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(key)
  )
    throw new StoreCursorError();
  return { sort, key: key as string | number, id };
}

/**
 * One page of visible products. Sort keys and directions come from a fixed list (never from
 * the request text); every sort ends on the product ID, so pages are stable.
 */
export async function listStoreProducts(
  db: Database,
  input: StoreProductsQuery,
): Promise<{ rows: StoreProductCardRow[]; nextCursor: string | null }> {
  const query = storeProductsQuerySchema.parse(input);
  const after = query.cursor ? decodeCursor(query.cursor, query.sort) : null;
  // `q` is the filtered, visible set with its computed price; ordering happens outside it.
  const order = {
    newest: {
      key: Prisma.sql`q.id::text`,
      by: Prisma.sql`q.id DESC`,
      after: (p: Position) => Prisma.sql`q.id < ${p.id}::uuid`,
    },
    name: {
      key: Prisma.sql`q.sort_name`,
      by: Prisma.sql`q.sort_name ASC, q.id ASC`,
      after: (p: Position) => Prisma.sql`(q.sort_name, q.id) > (${p.key}, ${p.id}::uuid)`,
    },
    price_asc: {
      key: Prisma.sql`q."priceFromFils"`,
      by: Prisma.sql`q."priceFromFils" ASC, q.id ASC`,
      after: (p: Position) =>
        Prisma.sql`(q."priceFromFils", q.id) > (${p.key}::int, ${p.id}::uuid)`,
    },
    price_desc: {
      key: Prisma.sql`q."priceFromFils"`,
      by: Prisma.sql`q."priceFromFils" DESC, q.id DESC`,
      after: (p: Position) =>
        Prisma.sql`(q."priceFromFils", q.id) < (${p.key}::int, ${p.id}::uuid)`,
    },
  }[query.sort];
  const filters = [VISIBLE_PRODUCT];
  if (query.brand) filters.push(Prisma.sql`b.slug=${query.brand}`);
  if (query.category) filters.push(Prisma.sql`c.slug=${query.category}`);
  if (query.type) filters.push(Prisma.sql`p.type=${query.type}`);
  const rows = await db.$queryRaw<Array<StoreProductCardRow & { cursorKey: string | number }>>(
    Prisma.sql`
    WITH q AS (
      SELECT p.id, p.slug, p.name, p.type, lower(p.name) AS sort_name,
        b.name AS "brandName", b.slug AS "brandSlug",
        c.name AS "categoryName", c.slug AS "categorySlug",
        p.puff_count AS "puffCount", p.is_new AS "isNew",
        s.price_from::int AS "priceFromFils", s.variant_count::int AS "variantCount",
        NOT s.in_stock AS "soldOut",
        CASE WHEN p.compare_at_price_fils > s.price_from
          THEN p.compare_at_price_fils::int END AS "compareAtPriceFils"
      ${PRODUCT_FROM}
      CROSS JOIN LATERAL (
        SELECT min(coalesce(v.price_override_fils, p.base_price_fils)) AS price_from,
          count(*) AS variant_count, bool_or(v.stock_on_hand > 0) AS in_stock
        FROM variants v WHERE v.product_id=p.id AND v.active) s
      WHERE ${Prisma.join(filters, " AND ")})
    SELECT q.*, ${order.key} AS "cursorKey",
      (SELECT jsonb_build_object('alt', i.alt, 'width', i.width, 'height', i.height,
          'derivativeKeys', m.derivative_keys)
        FROM product_images i JOIN media_assets m ON m.id=i.media_asset_id
        WHERE i.product_id=q.id AND m.state='ready'
        ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 1) AS image
    FROM q ${after ? Prisma.sql`WHERE ${order.after(after)}` : Prisma.empty}
    ORDER BY ${order.by} LIMIT ${query.limit + 1}`,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    rows: page.map(({ cursorKey: _key, ...row }) => row),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ sort: query.sort, key: last.cursorKey, id: last.id })
        : null,
  };
}

export interface StoreProductDetail {
  slug: string;
  name: string;
  type: "disposable" | "kit";
  brand: { name: string; slug: string };
  category: { name: string; slug: string };
  puffCount: number | null;
  isNew: boolean;
  description: string;
  specs: Record<string, unknown>;
  seo: { title: string | null; description: string | null };
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    id: string;
    attributes: Record<string, string>;
    isDefault: boolean;
    priceFils: number;
    compareAtPriceFils: number | null;
    available: boolean;
  }>;
  soldOut: boolean;
  images: StoreImageRow[];
  rating: StoreRating | null;
  reviews: StoreReview[];
}

/**
 * A visible product by its slug, or by a slug it used to have (the caller compares `slug` with
 * the requested one and redirects). Null for anything a shopper may not see: unknown, draft,
 * trashed and hidden-parent products are indistinguishable.
 */
export async function readStoreProduct(
  db: Database,
  slug: string,
): Promise<StoreProductDetail | null> {
  return db.$transaction(
    async (tx) => {
      const [product] = await tx.$queryRaw<
        Array<{
          id: string;
          slug: string;
          name: string;
          type: "disposable" | "kit";
          brandName: string;
          brandSlug: string;
          categoryName: string;
          categorySlug: string;
          puffCount: number | null;
          isNew: boolean;
          description: string;
          specs: Record<string, unknown>;
          seo: { title?: string | null; description?: string | null };
          basePriceFils: number;
          compareAtPriceFils: number | null;
        }>
      >(Prisma.sql`
        SELECT p.id, p.slug, p.name, p.type, b.name AS "brandName", b.slug AS "brandSlug",
          c.name AS "categoryName", c.slug AS "categorySlug", p.puff_count AS "puffCount",
          p.is_new AS "isNew", p.description, p.specs, p.seo,
          p.base_price_fils::int AS "basePriceFils",
          p.compare_at_price_fils::int AS "compareAtPriceFils"
        ${PRODUCT_FROM}
        WHERE ${VISIBLE_PRODUCT} AND (p.slug=${slug} OR p.id=(
          SELECT r.product_id FROM slug_redirects r
          WHERE r.entity_type='product' AND r.old_slug=${slug}))
        -- The current slug wins over a redirect that happens to point elsewhere.
        ORDER BY (p.slug=${slug}) DESC LIMIT 1`);
      if (!product) return null;
      const options = await tx.$queryRaw<Array<{ name: string; values: string[] }>>(Prisma.sql`
        SELECT name, allowed_values AS values FROM product_options
        WHERE product_id=${product.id}::uuid ORDER BY sort_order, id`);
      const variants = await tx.$queryRaw<
        Array<{
          id: string;
          attributes: Record<string, string>;
          isDefault: boolean;
          priceFils: number;
          stockOnHand: number;
        }>
      >(Prisma.sql`
        SELECT id, attributes, is_default AS "isDefault", stock_on_hand AS "stockOnHand",
          coalesce(price_override_fils, ${product.basePriceFils})::int AS "priceFils"
        FROM variants WHERE product_id=${product.id}::uuid AND active
        ORDER BY is_default DESC, option_signature, id LIMIT 500`);
      const images = await tx.$queryRaw<StoreImageRow[]>(Prisma.sql`
        SELECT i.alt, i.width, i.height, m.derivative_keys AS "derivativeKeys"
        FROM product_images i JOIN media_assets m ON m.id=i.media_asset_id
        WHERE i.product_id=${product.id}::uuid AND m.state='ready'
        ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 8`);
      const availability = productAvailability(
        variants.map((variant) => ({ ...variant, active: true })),
      );
      const { rating, reviews } = await readProductReviews(tx, product.id);
      return {
        slug: product.slug,
        name: product.name,
        type: product.type,
        brand: { name: product.brandName, slug: product.brandSlug },
        category: { name: product.categoryName, slug: product.categorySlug },
        puffCount: product.puffCount,
        isNew: product.isNew,
        description: product.description,
        specs: product.specs,
        seo: { title: product.seo.title ?? null, description: product.seo.description ?? null },
        options,
        variants: variants.map(({ stockOnHand: _stock, ...variant }) => ({
          ...variant,
          compareAtPriceFils:
            product.compareAtPriceFils !== null && product.compareAtPriceFils > variant.priceFils
              ? product.compareAtPriceFils
              : null,
          available: availability.availableVariantIds.includes(variant.id),
        })),
        soldOut: availability.soldOut,
        images,
        rating,
        reviews,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export interface StoreCartLineRow {
  variantId: string;
  productSlug: string;
  name: string;
  brand: string;
  options: string;
  priceFils: number;
  compareAtPriceFils: number | null;
  available: boolean;
  image: StoreImageRow | null;
}

/**
 * Current data for device-cart variants (roadmap step 62). Returns only active variants of
 * visible products; any other requested ID is simply absent, so a hidden or removed variant is
 * indistinguishable from one that never existed. Stock is reported as a yes/no.
 */
export async function readStoreCartLines(
  db: Database,
  variantIds: readonly string[],
): Promise<StoreCartLineRow[]> {
  if (!variantIds.length) return [];
  return db.$queryRaw<StoreCartLineRow[]>(Prisma.sql`
    SELECT cv.id AS "variantId", p.slug AS "productSlug", p.name, b.name AS brand,
      coalesce((SELECT string_agg(cv.attributes->>o.name, ' · ' ORDER BY o.sort_order, o.id)
        FROM product_options o WHERE o.product_id=p.id AND cv.attributes ? o.name), '')
        AS options,
      coalesce(cv.price_override_fils, p.base_price_fils)::int AS "priceFils",
      CASE WHEN p.compare_at_price_fils > coalesce(cv.price_override_fils, p.base_price_fils)
        THEN p.compare_at_price_fils::int END AS "compareAtPriceFils",
      cv.stock_on_hand > 0 AS available,
      (SELECT jsonb_build_object('alt', i.alt, 'width', i.width, 'height', i.height,
          'derivativeKeys', m.derivative_keys)
        FROM product_images i JOIN media_assets m ON m.id=i.media_asset_id
        WHERE i.product_id=p.id AND m.state='ready'
        ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 1) AS image
    FROM variants cv
    JOIN products p ON p.id=cv.product_id
    JOIN brands b ON b.id=p.brand_id
    JOIN categories c ON c.id=p.category_id
    WHERE cv.id = ANY(${[...variantIds]}::uuid[]) AND cv.active AND ${VISIBLE_PRODUCT}
    ORDER BY cv.id LIMIT 50`);
}

/**
 * Cards for remembered product slugs (roadmap step 63), in the order asked. A slug is matched
 * as the current slug of a visible product or, failing that, as a former slug of one. Anything
 * else is absent, so hidden and unknown products are indistinguishable.
 */
export async function readStoreProductCards(
  db: Database,
  slugs: readonly string[],
): Promise<Array<{ requested: string; row: StoreProductCardRow }>> {
  if (!slugs.length) return [];
  const rows = await db.$queryRaw<Array<StoreProductCardRow & { requested: string }>>(Prisma.sql`
    SELECT r.slug AS requested, p.id, p.slug, p.name, p.type,
      b.name AS "brandName", b.slug AS "brandSlug",
      c.name AS "categoryName", c.slug AS "categorySlug",
      p.puff_count AS "puffCount", p.is_new AS "isNew",
      s.price_from::int AS "priceFromFils", s.variant_count::int AS "variantCount",
      NOT s.in_stock AS "soldOut",
      CASE WHEN p.compare_at_price_fils > s.price_from
        THEN p.compare_at_price_fils::int END AS "compareAtPriceFils",
      (SELECT jsonb_build_object('alt', i.alt, 'width', i.width, 'height', i.height,
          'derivativeKeys', m.derivative_keys)
        FROM product_images i JOIN media_assets m ON m.id=i.media_asset_id
        WHERE i.product_id=p.id AND m.state='ready'
        ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 1) AS image
    FROM unnest(${[...slugs]}::text[]) WITH ORDINALITY AS r(slug, position)
    JOIN products p ON p.id = coalesce(
      (SELECT x.id FROM products x WHERE x.slug=r.slug),
      (SELECT d.product_id FROM slug_redirects d
        WHERE d.entity_type='product' AND d.old_slug=r.slug))
    JOIN brands b ON b.id=p.brand_id
    JOIN categories c ON c.id=p.category_id
    CROSS JOIN LATERAL (
      SELECT min(coalesce(v.price_override_fils, p.base_price_fils)) AS price_from,
        count(*) AS variant_count, bool_or(v.stock_on_hand > 0) AS in_stock
      FROM variants v WHERE v.product_id=p.id AND v.active) s
    WHERE ${VISIBLE_PRODUCT}
    ORDER BY r.position LIMIT 24`);
  return rows.map(({ requested, ...row }) => ({ requested, row }));
}

/**
 * Owner settings shown to shoppers (roadmap step 64). Only the WhatsApp number is read; nothing
 * else in `settings` (recipients, templates, legal name) leaves the database through this.
 */
export async function readStoreInfo(db: Database): Promise<{ whatsappNumber: string | null }> {
  const [row] = await db.$queryRaw<Array<{ number: string | null }>>(Prisma.sql`
    SELECT value->>'number' AS number FROM settings WHERE key='whatsapp'`);
  const number = row?.number ?? null;
  // Written through a validated contract; anything else is treated as not configured.
  return { whatsappNumber: number && /^\+[1-9]\d{7,14}$/.test(number) ? number : null };
}
