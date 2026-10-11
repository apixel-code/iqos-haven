import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { createLogger } from "@ih/logger";
import {
  DERIVATIVE_NAMES,
  disposableSpecsSchema,
  kitSpecsSchema,
  type StoreBrandsResponse,
  type StoreCartLinesResponse,
  type StoreCategoriesResponse,
  type StoreImage,
  type StoreProductCard,
  type StoreProductResponse,
  type StoreProductsQuery,
  type StoreProductsResponse,
} from "@ih/contracts";
import {
  assertStoreCursor,
  listStoreBrands,
  listStoreCategories,
  listStoreProducts,
  readStoreCartLines,
  readStoreProduct,
  type Database,
  type StoreImageRow,
  type StoreProductCardRow,
} from "@ih/db";
import type { ObjectStorage } from "@ih/platform";
import { CatalogueCacheService } from "../cache/catalogue-cache.service";
import { API_ENV, DATABASE, OBJECT_STORAGE } from "../infra/tokens";

/**
 * Links to sanitized derivatives in the private media bucket. They outlive the cache TTL (60 s)
 * by a wide margin, so a cached response never carries a link about to expire.
 */
const IMAGE_LINK_SECONDS = 10 * 60;

/**
 * Shopper catalogue reads through the catalogue cache (roadmap step 58, ADR 0027). The age
 * ticket is checked by the route policy before any method here runs, including on cache hits.
 * Cache keys are built from validated, bounded input only. Cached values are the same for
 * every shopper: nothing personal is read or stored.
 */
@Injectable()
export class StoreCatalogService {
  private readonly log;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_ENV) env: ApiEnv,
    private readonly cache: CatalogueCacheService,
  ) {
    this.log = createLogger({ service: "api-store-catalog", level: env.LOG_LEVEL });
  }

  /** Signing is local (no network call). A ready image always has every derivative. */
  private async image(row: StoreImageRow): Promise<StoreImage> {
    const urls = Object.fromEntries(
      await Promise.all(
        DERIVATIVE_NAMES.map(async (name) => {
          const key = row.derivativeKeys[name];
          if (!key) throw new Error("Store image without derivative");
          return [
            name,
            await this.storage.presignDownload("media", key, {
              expiresInSeconds: IMAGE_LINK_SECONDS,
            }),
          ];
        }),
      ),
    ) as StoreImage["urls"];
    return { alt: row.alt, width: row.width, height: row.height, urls };
  }

  /** A list card from its row; shared with search so both show the same fields. */
  async card(row: StoreProductCardRow): Promise<StoreProductCard> {
    return {
      slug: row.slug,
      name: row.name,
      type: row.type,
      brand: { name: row.brandName, slug: row.brandSlug },
      category: { name: row.categoryName, slug: row.categorySlug },
      puffCount: row.puffCount,
      isNew: row.isNew,
      priceFromFils: row.priceFromFils,
      compareAtPriceFils: row.compareAtPriceFils,
      variantCount: row.variantCount,
      soldOut: row.soldOut,
      image: row.image ? await this.image(row.image) : null,
    };
  }

  /**
   * Current data for the variants in a device cart. Not cached: the ID list is the shopper's own,
   * and a cart should see a deactivated or sold-out variant as soon as possible.
   */
  async cartLines(variantIds: readonly string[]): Promise<StoreCartLinesResponse> {
    const rows = await readStoreCartLines(this.db, variantIds);
    return {
      lines: await Promise.all(
        rows.map(async ({ image, ...row }) => ({
          ...row,
          image: image ? await this.image(image) : null,
        })),
      ),
    };
  }

  brands(): Promise<StoreBrandsResponse> {
    return this.cache.getOrLoad("store:brands", async () => ({
      items: (await listStoreBrands(this.db)).map((row) => ({
        name: row.name,
        slug: row.slug,
        description: row.description ?? "",
        productCount: row.productCount,
      })),
    }));
  }

  categories(): Promise<StoreCategoriesResponse> {
    return this.cache.getOrLoad("store:categories", async () => ({
      items: (await listStoreCategories(this.db)).map((row) => ({
        name: row.name,
        slug: row.slug,
        productCount: row.productCount,
      })),
    }));
  }

  /**
   * First pages are cached. Later pages are read directly: a cursor is free-form enough that
   * caching each one would let a client fill the cache with entries nobody else will ask for.
   */
  products(query: StoreProductsQuery): Promise<StoreProductsResponse> {
    // Refuse a malformed cursor before it can take a load slot or reach the database.
    if (query.cursor) {
      assertStoreCursor(query.cursor, query.sort);
      return this.loadProducts(query);
    }
    // Fixed field order: the same query always maps to the same key.
    const key = JSON.stringify([
      query.brand ?? null,
      query.category ?? null,
      query.type ?? null,
      query.sort,
      query.limit,
    ]);
    return this.cache.getOrLoad(`store:products:${key}`, () => this.loadProducts(query));
  }

  private async loadProducts(query: StoreProductsQuery): Promise<StoreProductsResponse> {
    {
      const page = await listStoreProducts(this.db, query);
      return {
        items: await Promise.all(page.rows.map((row) => this.card(row))),
        nextCursor: page.nextCursor,
      };
    }
  }

  /**
   * Null when no visible product has, or had, this slug. A miss is never cached: unknown slugs
   * are unbounded, and caching them would push real entries out. The lookup that finds nothing
   * is a single indexed query.
   */
  async product(slug: string): Promise<StoreProductResponse | null> {
    try {
      return await this.cache.getOrLoad(`store:product:${slug}`, async () => {
        const product = await readStoreProduct(this.db, slug);
        if (!product) throw new NotVisible();
        return {
          ...product,
          specs: this.specs(product.type, product.specs),
          images: await Promise.all(product.images.map((row) => this.image(row))),
        };
      });
    } catch (error) {
      if (error instanceof NotVisible) return null;
      throw error;
    }
  }

  /**
   * Specs are written through the admin contract, so this parse normally succeeds. A row that
   * does not fit (edited outside the API) shows no specifications instead of failing the page.
   */
  private specs(type: "disposable" | "kit", stored: unknown): StoreProductResponse["specs"] {
    const parsed = (type === "kit" ? kitSpecsSchema : disposableSpecsSchema).safeParse(stored);
    if (parsed.success) return parsed.data;
    this.log.warn({ type }, "stored product specs do not match the contract");
    return { extra: [] };
  }
}

/** Loader signal for "nothing a shopper may see"; errors are never cached. */
class NotVisible extends Error {}
