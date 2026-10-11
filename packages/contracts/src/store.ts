import { z } from "zod";
import { catalogueSlugSchema } from "./catalogue";
import { disposableSpecsSchema, kitSpecsSchema, productFilsSchema } from "./products";

/**
 * Shopper catalogue reads (roadmap step 58, architecture §10 "Store reads"). Served only to a
 * request with a valid age ticket. Everything here is published, active, non-deleted catalogue
 * data: no cost, SKU, stock count, version, tax reference or staff field ever appears.
 * Money is integer fils.
 */
export const STORE_PAGE_SIZES = { default: 24, max: 48 } as const;
export const STORE_PRODUCT_SORTS = ["newest", "price_asc", "price_desc", "name"] as const;
export type StoreProductSort = (typeof STORE_PRODUCT_SORTS)[number];

const parentRef = z.strictObject({ name: z.string(), slug: z.string() });
/** Short-lived signed links to sanitized derivatives; never the original upload. */
const storeImageSchema = z.strictObject({
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  urls: z.strictObject({ large: z.url(), medium: z.url(), thumb: z.url() }),
});
export type StoreImage = z.infer<typeof storeImageSchema>;

export const storeBrandsResponseSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: z.string(),
        slug: z.string(),
        description: z.string(),
        /** Products a shopper can see under this brand. */
        productCount: z.number().int().min(0),
      }),
    )
    .max(500),
});
export type StoreBrandsResponse = z.infer<typeof storeBrandsResponseSchema>;

export const storeCategoriesResponseSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: z.string(),
        slug: z.string(),
        productCount: z.number().int().min(0),
      }),
    )
    .max(500),
});
export type StoreCategoriesResponse = z.infer<typeof storeCategoriesResponseSchema>;

/** Opaque keyset position issued by the API; bounded and re-validated when it comes back. */
const cursor = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[A-Za-z0-9_-]+$/);
export const storeProductsQuerySchema = z.strictObject({
  brand: catalogueSlugSchema.optional(),
  category: catalogueSlugSchema.optional(),
  type: z.enum(["disposable", "kit"]).optional(),
  sort: z.enum(STORE_PRODUCT_SORTS).default("newest"),
  limit: z.coerce.number().int().min(1).max(STORE_PAGE_SIZES.max).default(STORE_PAGE_SIZES.default),
  cursor: cursor.optional(),
});
export type StoreProductsQuery = z.infer<typeof storeProductsQuerySchema>;

export const storeProductCardSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  type: z.enum(["disposable", "kit"]),
  brand: parentRef,
  category: parentRef,
  puffCount: z.number().int().positive().nullable(),
  isNew: z.boolean(),
  /** Lowest price among the options a shopper can choose. */
  priceFromFils: productFilsSchema,
  /** Previous price for display, only when above `priceFromFils`. */
  compareAtPriceFils: productFilsSchema.nullable(),
  /** Number of selectable options (active variants). */
  variantCount: z.number().int().min(1),
  /** No active option has stock. The product stays listed. */
  soldOut: z.boolean(),
  image: storeImageSchema.nullable(),
});
export type StoreProductCard = z.infer<typeof storeProductCardSchema>;
export const storeProductsResponseSchema = z.strictObject({
  items: z.array(storeProductCardSchema).max(STORE_PAGE_SIZES.max),
  nextCursor: z.string().nullable(),
});
export type StoreProductsResponse = z.infer<typeof storeProductsResponseSchema>;

export const storeProductParamsSchema = z.strictObject({ slug: catalogueSlugSchema });

export const storeProductResponseSchema = z.strictObject({
  /** Current slug. Differs from the requested one after a rename: redirect to it. */
  slug: z.string(),
  name: z.string(),
  type: z.enum(["disposable", "kit"]),
  brand: parentRef,
  category: parentRef,
  puffCount: z.number().int().positive().nullable(),
  isNew: z.boolean(),
  description: z.string(),
  specs: z.union([disposableSpecsSchema, kitSpecsSchema]),
  /** Page title/description chosen by the Owner, if any. Only for verified shoppers. */
  seo: z.strictObject({ title: z.string().nullable(), description: z.string().nullable() }),
  options: z
    .array(z.strictObject({ name: z.string(), values: z.array(z.string()).max(100) }))
    .max(8),
  /** Active options only. An unavailable one stays listed and is never swapped for another. */
  variants: z
    .array(
      z.strictObject({
        id: z.uuid(),
        attributes: z.record(z.string(), z.string()),
        isDefault: z.boolean(),
        priceFils: productFilsSchema,
        compareAtPriceFils: productFilsSchema.nullable(),
        available: z.boolean(),
      }),
    )
    .min(1)
    .max(500),
  soldOut: z.boolean(),
  images: z.array(storeImageSchema).max(8),
});
export type StoreProductResponse = z.infer<typeof storeProductResponseSchema>;
