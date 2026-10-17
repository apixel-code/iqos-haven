import {
  type StoreSearchQuery,
  type StoreSearchResponse,
  type StoreSearchSort,
} from "@ih/contracts";
import { normalizeSearchTerm, prefixTsQuery, type SearchTerm } from "@ih/domain";
import { Prisma, type Database } from "./client";
import {
  decodeCursor,
  encodeCursor,
  PRODUCT_FROM,
  VISIBLE_PRODUCT,
  type StoreProductCardRow,
} from "./store-catalogue";

/**
 * Shopper search, suggestions and facets (roadmap step 60, ADR 0029). Matching uses the
 * `product_search` projection: full-text prefix match on every token, or trigram word similarity
 * for near misses. Visibility is the same rule as every other store read. All SQL identifiers and
 * sort expressions are fixed here; request values only ever travel as bound parameters, and the
 * search text is reduced to letters and digits before it is used.
 */
const SIMILARITY_THRESHOLD = "0.35";
/** Below this length a trigram comparison is noise; the term matches by word prefix only. */
const MIN_FUZZY_LENGTH = 3;
/** Rank is stored as an integer (×10 000) so it can be a stable keyset key. */
const MAX_RANK = 100_000_000;

type MatchMode = "exact" | "approximate";

/**
 * Exact: every token matches a word by prefix (full-text). Approximate, used only when exact
 * finds nothing: every token must still be accounted for, a word token by trigram similarity to
 * some word of the text, a token with digits by exact prefix (a puff count or strength is never
 * "roughly" right).
 */
function matchSql(term: SearchTerm, mode: MatchMode) {
  if (!term.tokens.length)
    return { match: Prisma.sql`TRUE`, rank: Prisma.sql`(0)::int`, join: Prisma.empty };
  const join = Prisma.sql`JOIN product_search ps ON ps.product_id=p.id`;
  const tsq = Prisma.sql`to_tsquery('simple', ${prefixTsQuery(term)})`;
  if (mode === "exact")
    return {
      join,
      match: Prisma.sql`ps.document @@ ${tsq}`,
      rank: Prisma.sql`round(ts_rank(ps.document, ${tsq}) * 100000)::int`,
    };
  const fuzzy = term.tokens.filter(
    (token) => token.length >= MIN_FUZZY_LENGTH && !/\p{N}/u.test(token),
  );
  const strict = term.tokens.filter((token) => !fuzzy.includes(token));
  const parts = [
    ...fuzzy.map((token) => Prisma.sql`${token} OPERATOR(public.<%) ps.search_text`),
    ...strict.map(
      (token) =>
        Prisma.sql`ps.document @@ to_tsquery('simple', ${prefixTsQuery({ text: token, tokens: [token] })})`,
    ),
  ];
  return {
    join,
    match: Prisma.join(parts, " AND "),
    rank: fuzzy.length
      ? Prisma.sql`round((${Prisma.join(
          fuzzy.map((token) => Prisma.sql`public.word_similarity(${token}, ps.search_text)`),
          " + ",
        )}) * 10000)::int`
      : Prisma.sql`(0)::int`,
  };
}

/** Whether an approximate pass can find anything an exact pass could not. */
const canApproximate = (term: SearchTerm) =>
  term.tokens.some((token) => token.length >= MIN_FUZZY_LENGTH && !/\p{N}/u.test(token));

/** The matched, visible products with everything filters, facets and cards need. */
function matchedSql(term: SearchTerm, mode: MatchMode) {
  const { join, match, rank } = matchSql(term, mode);
  return Prisma.sql`
    SELECT p.id, p.slug, p.name, p.type, lower(p.name) AS sort_name,
      b.name AS "brandName", b.slug AS "brandSlug",
      c.name AS "categoryName", c.slug AS "categorySlug",
      p.puff_count AS "puffCount", p.is_new AS "isNew",
      s.price_from::int AS "priceFromFils", s.variant_count::int AS "variantCount",
      NOT s.in_stock AS "soldOut",
      CASE WHEN p.compare_at_price_fils > s.price_from
        THEN p.compare_at_price_fils::int END AS "compareAtPriceFils",
      s.nicotine, ${rank} AS rank
    ${PRODUCT_FROM} ${join}
    CROSS JOIN LATERAL (
      SELECT min(coalesce(v.price_override_fils, p.base_price_fils)) AS price_from,
        count(*) AS variant_count, bool_or(v.stock_on_hand > 0) AS in_stock,
        coalesce(array_agg(DISTINCT lower(v.attributes->>'nicotine'))
          FILTER (WHERE v.attributes ? 'nicotine'), '{}') AS nicotine
      FROM variants v WHERE v.product_id=p.id AND v.active) s
    WHERE ${VISIBLE_PRODUCT} AND ${match}`;
}

/**
 * A cursor remembers which pass produced its page (the sort tag ends in "~" for near misses), so
 * later pages continue in the same result set even if the catalogue changed in between.
 */
const APPROXIMATE_TAG = "~";
function decodeSearchCursor(cursor: string, sort: StoreSearchSort) {
  const numeric =
    sort === "relevance"
      ? MAX_RANK
      : sort === "price_asc" || sort === "price_desc"
        ? undefined
        : null;
  try {
    return { mode: "exact" as MatchMode, position: decodeCursor(cursor, sort, numeric) };
  } catch {
    return {
      mode: "approximate" as MatchMode,
      position: decodeCursor(cursor, `${sort}${APPROXIMATE_TAG}`, numeric),
    };
  }
}

/** `category` is a page's scope, never a facet: it applies to every count. */
type FacetKey =
  "type" | "brand" | "category" | "price" | "puffs" | "nicotine" | "inStock" | "onSale";

/** One predicate per active filter, over the columns of the matched set `m`. */
function filterSql(query: StoreSearchQuery): Partial<Record<FacetKey, Prisma.Sql>> {
  const filters: Partial<Record<FacetKey, Prisma.Sql>> = {};
  if (query.type) filters.type = Prisma.sql`m.type=${query.type}`;
  if (query.brand?.length) filters.brand = Prisma.sql`m."brandSlug" = ANY(${query.brand}::text[])`;
  if (query.category) filters.category = Prisma.sql`m."categorySlug" = ${query.category}`;
  if (query.minPriceFils !== undefined || query.maxPriceFils !== undefined)
    filters.price = Prisma.sql`m."priceFromFils" BETWEEN ${query.minPriceFils ?? 0}::int
      AND ${query.maxPriceFils ?? 1_000_000_000}::int`;
  if (query.minPuffs !== undefined || query.maxPuffs !== undefined)
    filters.puffs = Prisma.sql`m."puffCount" BETWEEN ${query.minPuffs ?? 1}::int
      AND ${query.maxPuffs ?? 1_000_000}::int`;
  if (query.nicotine?.length)
    filters.nicotine = Prisma.sql`m.nicotine && ${query.nicotine.map((value) =>
      value.toLowerCase(),
    )}::text[]`;
  if (query.inStock) filters.inStock = Prisma.sql`NOT m."soldOut"`;
  if (query.onSale) filters.onSale = Prisma.sql`m."compareAtPriceFils" IS NOT NULL`;
  return filters;
}

const allOf = (parts: Prisma.Sql[]) =>
  parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;

export interface StoreSearchResult extends Omit<StoreSearchResponse, "items"> {
  rows: StoreProductCardRow[];
}
const strip = ({
  unfilteredTotal: _unfiltered,
  ...result
}: StoreSearchResult & { unfilteredTotal: number }): StoreSearchResult => result;

export async function searchStoreProducts(
  db: Database,
  input: StoreSearchQuery,
): Promise<StoreSearchResult> {
  // Already parsed by the caller: the schema transforms values, so it is not applied twice.
  const query = input;
  const term = normalizeSearchTerm(query.q);
  const requested = query.sort ?? (term.tokens.length ? "relevance" : "newest");
  // Without a term every rank is 0, so relevance would be an arbitrary order.
  const sort: StoreSearchSort =
    requested === "relevance" && !term.tokens.length ? "newest" : requested;
  const resumed = query.cursor ? decodeSearchCursor(query.cursor, sort) : null;
  const after = resumed?.position ?? null;
  const filters = filterSql(query);
  const all = allOf(Object.values(filters));
  /** Every active filter except the facet's own (see the response contract). */
  const except = (key: FacetKey) =>
    allOf(
      Object.entries(filters)
        .filter(([name]) => name !== key)
        .map(([, sql]) => sql),
    );
  const order = {
    relevance: {
      key: Prisma.sql`m.rank`,
      by: Prisma.sql`m.rank DESC, m.id DESC`,
      after: (key: string | number, id: string) =>
        Prisma.sql`(m.rank, m.id) < (${key}::int, ${id}::uuid)`,
    },
    newest: {
      key: Prisma.sql`m.id::text`,
      by: Prisma.sql`m.id DESC`,
      after: (_key: string | number, id: string) => Prisma.sql`m.id < ${id}::uuid`,
    },
    name: {
      key: Prisma.sql`m.sort_name`,
      by: Prisma.sql`m.sort_name ASC, m.id ASC`,
      after: (key: string | number, id: string) =>
        Prisma.sql`(m.sort_name, m.id) > (${key}, ${id}::uuid)`,
    },
    price_asc: {
      key: Prisma.sql`m."priceFromFils"`,
      by: Prisma.sql`m."priceFromFils" ASC, m.id ASC`,
      after: (key: string | number, id: string) =>
        Prisma.sql`(m."priceFromFils", m.id) > (${key}::int, ${id}::uuid)`,
    },
    price_desc: {
      key: Prisma.sql`m."priceFromFils"`,
      by: Prisma.sql`m."priceFromFils" DESC, m.id DESC`,
      after: (key: string | number, id: string) =>
        Prisma.sql`(m."priceFromFils", m.id) < (${key}::int, ${id}::uuid)`,
    },
  }[sort];

  return db.$transaction(
    async (tx) => {
      const run = async (mode: MatchMode) => {
        const matched = matchedSql(term, mode);
        // Trigram matching threshold for this transaction only.
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${SIMILARITY_THRESHOLD}, true)`,
        );
        const rows = await tx.$queryRaw<
          Array<StoreProductCardRow & { cursorKey: string | number }>
        >(
          Prisma.sql`
        WITH m AS (${matched})
        SELECT m.id, m.slug, m.name, m.type, m."brandName", m."brandSlug", m."categoryName",
          m."categorySlug", m."puffCount", m."isNew", m."priceFromFils", m."variantCount",
          m."soldOut", m."compareAtPriceFils", ${order.key} AS "cursorKey",
          (SELECT jsonb_build_object('alt', i.alt, 'width', i.width, 'height', i.height,
              'derivativeKeys', a.derivative_keys)
            FROM product_images i JOIN media_assets a ON a.id=i.media_asset_id
            WHERE i.product_id=m.id AND a.state='ready'
            ORDER BY i.is_primary DESC, i.sort_order, i.id LIMIT 1) AS image
        FROM m WHERE ${all}
          ${after ? Prisma.sql`AND ${order.after(after.key, after.id)}` : Prisma.empty}
        ORDER BY ${order.by} LIMIT ${query.limit + 1}`,
        );
        const [facets] = await tx.$queryRaw<
          Array<{
            total: number;
            unfilteredTotal: number;
            types: StoreSearchResponse["facets"]["types"];
            brands: StoreSearchResponse["facets"]["brands"];
            puffCounts: StoreSearchResponse["facets"]["puffCounts"];
            nicotine: StoreSearchResponse["facets"]["nicotine"];
            price: { minFils: number | null; maxFils: number | null };
            inStock: number;
            onSale: number;
          }>
        >(Prisma.sql`
        WITH m AS MATERIALIZED (${matched})
        SELECT
          (SELECT count(*)::int FROM m WHERE ${all}) AS total,
          (SELECT count(*)::int FROM m) AS "unfilteredTotal",
          (SELECT coalesce(jsonb_agg(jsonb_build_object('type', x.type, 'count', x.n)
              ORDER BY x.type), '[]'::jsonb)
            FROM (SELECT m.type, count(*)::int AS n FROM m WHERE ${except("type")}
              GROUP BY m.type) x) AS types,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('slug', x.slug, 'name', x.name,
              'count', x.n) ORDER BY lower(x.name), x.slug), '[]'::jsonb)
            FROM (SELECT m."brandSlug" AS slug, m."brandName" AS name, count(*)::int AS n
              FROM m WHERE ${except("brand")} GROUP BY 1, 2
              ORDER BY count(*) DESC, 1 LIMIT 200) x) AS brands,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('puffCount', x.puffs, 'count', x.n)
              ORDER BY x.puffs), '[]'::jsonb)
            FROM (SELECT m."puffCount" AS puffs, count(*)::int AS n FROM m
              WHERE ${except("puffs")} AND m."puffCount" IS NOT NULL GROUP BY 1
              ORDER BY count(*) DESC, 1 LIMIT 100) x) AS "puffCounts",
          (SELECT coalesce(jsonb_agg(jsonb_build_object('value', x.value, 'count', x.n)
              ORDER BY x.value), '[]'::jsonb)
            FROM (SELECT n.value, count(*)::int AS n FROM m, unnest(m.nicotine) AS n(value)
              WHERE ${except("nicotine")} GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 50) x)
            AS nicotine,
          (SELECT jsonb_build_object('minFils', min(m."priceFromFils"),
              'maxFils', max(m."priceFromFils")) FROM m WHERE ${except("price")}) AS price,
          (SELECT count(*)::int FROM m WHERE ${except("inStock")} AND NOT m."soldOut")
            AS "inStock",
          (SELECT count(*)::int FROM m WHERE ${except("onSale")}
            AND m."compareAtPriceFils" IS NOT NULL) AS "onSale"`);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const price = facets!.price;
        return {
          query: term.text,
          approximate: mode === "approximate",
          sort,
          total: facets!.total,
          unfilteredTotal: facets!.unfilteredTotal,
          rows: page.map(({ cursorKey: _key, ...row }) => row),
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor({
                  sort: mode === "approximate" ? `${sort}${APPROXIMATE_TAG}` : sort,
                  key: last.cursorKey,
                  id: last.id,
                })
              : null,
          facets: {
            types: facets!.types,
            brands: facets!.brands,
            puffCounts: facets!.puffCounts,
            nicotine: facets!.nicotine,
            price:
              price.minFils === null || price.maxFils === null
                ? null
                : { minFils: price.minFils, maxFils: price.maxFils },
            inStock: facets!.inStock,
            onSale: facets!.onSale,
          },
        };
      };
      // Exact first. Only when it finds nothing at all (no filters considered) try near misses.
      // A later page continues the pass its cursor came from.
      if (resumed)
        return strip(
          await run(
            resumed.mode === "approximate" && canApproximate(term) ? "approximate" : "exact",
          ),
        );
      const exact = await run("exact");
      if (exact.unfilteredTotal > 0 || !canApproximate(term)) return strip(exact);
      return strip(await run("approximate"));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Validates a search cursor for the sort the query will use, without touching the database. */
export function assertStoreSearchCursor(input: StoreSearchQuery): void {
  if (!input.cursor) return;
  const hasTerm = normalizeSearchTerm(input.q).tokens.length > 0;
  const requested = input.sort ?? (hasTerm ? "relevance" : "newest");
  const sort = requested === "relevance" && !hasTerm ? "newest" : requested;
  decodeSearchCursor(input.cursor, sort);
}

const likePrefix = (text: string) => text.replace(/[\\%_]/g, (char) => "\\" + char) + "%";

/** Up to six products and four brands for a term of at least two characters. */
export async function suggestStoreSearch(db: Database, q: string) {
  const term = normalizeSearchTerm(q);
  if (term.text.length < 2) return { query: term.text, products: [], brands: [] };
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${SIMILARITY_THRESHOLD}, true)`,
      );
      const find = (mode: MatchMode) => {
        const { join, match, rank } = matchSql(term, mode);
        return tx.$queryRaw<Array<{ slug: string; name: string; brandName: string }>>(Prisma.sql`
          SELECT p.slug, p.name, b.name AS "brandName"
          ${PRODUCT_FROM} ${join}
          WHERE ${VISIBLE_PRODUCT} AND ${match}
          ORDER BY ${rank} DESC, p.id DESC LIMIT 6`);
      };
      let products = await find("exact");
      if (!products.length && canApproximate(term)) products = await find("approximate");
      const brands = await tx.$queryRaw<Array<{ slug: string; name: string }>>(Prisma.sql`
        SELECT x.slug, x.name FROM brands x
        WHERE x.active AND x.deleted_at IS NULL AND lower(x.name) LIKE ${likePrefix(term.text)}
          AND EXISTS (SELECT 1 ${PRODUCT_FROM} WHERE p.brand_id=x.id AND ${VISIBLE_PRODUCT})
        ORDER BY lower(x.name), x.id LIMIT 4`);
      return { query: term.text, products, brands };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
