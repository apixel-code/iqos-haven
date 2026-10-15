import {
  BEST_SELLERS_COUNT,
  CONTENT_SECTION_KEYS,
  contentReferences,
  contentSchema,
  type ContentLink,
  type ContentOf,
  type ContentSectionKey,
  type SectionContent,
} from "@ih/contracts";
import { Prisma, type Database, type Tx } from "./client";
import {
  PRODUCT_FROM,
  VISIBLE_PRODUCT,
  type StoreImageRow,
  type StoreProductCardRow,
} from "./store-catalogue";

/**
 * The published home page (roadmap step 98, ADR 0066). Only published copies are read, never a
 * draft. Every reference is checked again here, at read time: a product, brand or category
 * that is no longer visible, or an image that is not a ready content image, is left out
 * (a button to a hidden page is dropped). One repeatable-read snapshot, so the sections and
 * the products they show agree.
 */
export interface HomeLink {
  label: string;
  href: string;
}
export interface HomeBanner {
  title: string;
  subtitle: string | null;
  cta: HomeLink | null;
  image: StoreImageRow | null;
}
export interface PublishedHome {
  ticker: { messages: string[] } | null;
  hero: (HomeBanner & { eyebrow: string | null }) | null;
  featured: StoreProductCardRow[];
  bestSellers: StoreProductCardRow[];
  brands: Array<{ name: string; slug: string; productCount: number }>;
  banners: HomeBanner[];
  offers: { title: string; products: StoreProductCardRow[] } | null;
}

/** Product cards by ID, visible products only, in the order asked. */
async function cardsById(tx: Tx, ids: readonly string[]): Promise<StoreProductCardRow[]> {
  if (!ids.length) return [];
  const rows = await tx.$queryRaw<StoreProductCardRow[]>(Prisma.sql`
    SELECT p.id, p.slug, p.name, p.type,
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
    ${PRODUCT_FROM}
    CROSS JOIN LATERAL (
      SELECT min(coalesce(v.price_override_fils, p.base_price_fils)) AS price_from,
        count(*) AS variant_count, bool_or(v.stock_on_hand > 0) AS in_stock
      FROM variants v WHERE v.product_id=p.id AND v.active) s
    WHERE p.id = ANY(${[...ids]}::uuid[]) AND ${VISIBLE_PRODUCT}`);
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

/**
 * Best sellers worked out from orders: units of each visible, in-stock product in orders of
 * the last 30 days that were not cancelled. Ties go to the newer product.
 */
async function topSellerIds(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT i.product_id AS id
    FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.status <> 'cancelled'
      AND o.created_at > statement_timestamp() - interval '30 days'
    GROUP BY i.product_id
    ORDER BY sum(i.quantity) DESC, i.product_id DESC
    LIMIT 50`);
  return rows.map((row) => row.id);
}

export async function readPublishedHome(
  db: Database,
  onInvalid: (key: ContentSectionKey) => void = () => undefined,
): Promise<PublishedHome> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ key: ContentSectionKey; published: unknown; version: number }>
      >(Prisma.sql`
        SELECT key, published, published_schema_version AS version
        FROM content_sections WHERE published IS NOT NULL`);
      const published: Partial<{ [K in ContentSectionKey]: ContentOf<K> }> = {};
      for (const row of rows) {
        if (!(CONTENT_SECTION_KEYS as readonly string[]).includes(row.key)) continue;
        const parsed = contentSchema(row.key, row.version).safeParse(row.published);
        // Written through the API, so this holds; a row edited outside it is left out, loudly.
        if (parsed.success) (published as Record<string, SectionContent>)[row.key] = parsed.data;
        else onInvalid(row.key);
      }

      // Everything the sections point at, checked once against what a shopper can see.
      const refs = Object.values(published).map((content) => contentReferences(content));
      const all = (pick: (r: ReturnType<typeof contentReferences>) => string[]) => [
        ...new Set(refs.flatMap(pick)),
      ];
      const autoBest = published.best_sellers?.mode === "auto" ? await topSellerIds(tx) : [];
      const cards = new Map(
        (await cardsById(tx, [...new Set([...all((r) => r.productIds), ...autoBest])])).map(
          (card) => [card.id, card],
        ),
      );
      const brandIds = all((r) => r.brandIds);
      const brands = brandIds.length
        ? await tx.$queryRaw<
            Array<{ id: string; name: string; slug: string; productCount: number }>
          >(Prisma.sql`
            SELECT x.id, x.name, x.slug,
              (SELECT count(*)::int ${PRODUCT_FROM} WHERE p.brand_id=x.id AND ${VISIBLE_PRODUCT})
                AS "productCount"
            FROM brands x
            WHERE x.id = ANY(${brandIds}::uuid[]) AND x.active AND x.deleted_at IS NULL`)
        : [];
      const categoryIds = all((r) => r.categoryIds);
      const categories = categoryIds.length
        ? await tx.$queryRaw<Array<{ id: string; slug: string }>>(Prisma.sql`
            SELECT id, slug FROM categories
            WHERE id = ANY(${categoryIds}::uuid[]) AND active AND deleted_at IS NULL`)
        : [];
      const assetIds = all((r) => r.assetIds);
      const images = assetIds.length
        ? await tx.$queryRaw<
            Array<{
              id: string;
              width: number;
              height: number;
              derivativeKeys: Record<string, string>;
            }>
          >(Prisma.sql`
            SELECT id, width, height, derivative_keys AS "derivativeKeys" FROM media_assets
            WHERE id = ANY(${assetIds}::uuid[]) AND purpose='content' AND state='ready'`)
        : [];

      const productCards = (ids: readonly string[], options: { inStock?: boolean } = {}) =>
        ids
          .map((id) => cards.get(id))
          .filter(
            (card): card is StoreProductCardRow => !!card && !(options.inStock && card.soldOut),
          );
      const href = (link: ContentLink): string | null => {
        switch (link.kind) {
          case "shop":
            return "/shop";
          case "category": {
            const category = categories.find((row) => row.id === link.categoryId);
            return category ? `/categories/${category.slug}` : null;
          }
          case "brand": {
            const brand = brands.find((row) => row.id === link.brandId);
            return brand ? `/brands/${brand.slug}` : null;
          }
          case "product": {
            const card = cards.get(link.productId);
            return card ? `/p/${card.slug}` : null;
          }
        }
      };
      const cta = (value: { label: string; link: ContentLink } | null): HomeLink | null => {
        const target = value ? href(value.link) : null;
        return value && target ? { label: value.label, href: target } : null;
      };
      const image = (value: { assetId: string; alt: string } | null): StoreImageRow | null => {
        const found = value ? images.find((row) => row.id === value.assetId) : undefined;
        return value && found
          ? {
              alt: value.alt,
              width: found.width,
              height: found.height,
              derivativeKeys: found.derivativeKeys,
            }
          : null;
      };

      const { ticker, hero, featured, best_sellers, campaign_banner, offers } = published;
      return {
        ticker: ticker?.enabled ? { messages: ticker.messages } : null,
        hero: hero
          ? {
              eyebrow: hero.eyebrow,
              title: hero.title,
              subtitle: hero.subtitle,
              cta: cta(hero.cta),
              image: image(hero.image),
            }
          : null,
        featured: productCards(featured?.productIds ?? []),
        bestSellers: best_sellers
          ? best_sellers.mode === "auto"
            ? productCards(autoBest, { inStock: true }).slice(0, BEST_SELLERS_COUNT)
            : productCards(best_sellers.productIds)
          : [],
        brands: (published.brands?.brandIds ?? []).flatMap((id) =>
          brands
            .filter((row) => row.id === id)
            .map(({ name, slug, productCount }) => ({ name, slug, productCount })),
        ),
        banners: (campaign_banner?.banners ?? [])
          .filter((banner) => banner.enabled)
          .map((banner) => ({
            title: banner.title,
            subtitle: banner.subtitle,
            cta: cta(banner.cta),
            image: image(banner.image),
          })),
        offers: offers?.enabled
          ? { title: offers.title, products: productCards(offers.productIds) }
          : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
