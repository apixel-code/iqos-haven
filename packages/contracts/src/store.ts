import { z } from "zod";
import { ORDER_LIMITS, UAE_EMIRATES } from "@ih/domain";
import { catalogueSlugSchema } from "./catalogue";
import { checkoutAddressSchema, checkoutContactSchema, orderLinesSchema } from "./checkout";
import { couponCodeInputSchema } from "./coupons";
import { disposableSpecsSchema, kitSpecsSchema, productFilsSchema } from "./products";
import { STORE_REVIEWS_SHOWN, storeRatingSchema, storeReviewSchema } from "./reviews";

/**
 * Shopper catalogue reads (roadmap step 58, architecture §10 "Store reads"). Served only to a
 * request with a valid age ticket. Everything here is published, active, non-deleted catalogue
 * data: no cost, SKU, stock count, version, tax reference or staff field ever appears.
 * Money is integer fils.
 */
export const STORE_PAGE_SIZES = { default: 24, max: 48 } as const;
export const STORE_PRODUCT_SORTS = ["newest", "price_asc", "price_desc", "name"] as const;
export type StoreProductSort = (typeof STORE_PRODUCT_SORTS)[number];

/** http(s) only: these become `<img src>` in the storefront. */
const webUrl = z.url({ protocol: /^https?$/ });
const parentRef = z.strictObject({ name: z.string(), slug: catalogueSlugSchema });
/** Short-lived signed links to sanitized derivatives; never the original upload. */
const storeImageSchema = z.strictObject({
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  urls: z.strictObject({ large: webUrl, medium: webUrl, thumb: webUrl }),
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
        /** Earlier slugs that now redirect here (step 101): the page sends them to `slug`. */
        formerSlugs: z.array(z.string()).max(20),
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
        /** Earlier slugs that now redirect here (step 101). */
        formerSlugs: z.array(z.string()).max(20),
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
  /** Offers (step 100): only products shown with a reduced price (compare-at above the price). */
  sale: z.literal("1").optional(),
  sort: z.enum(STORE_PRODUCT_SORTS).default("newest"),
  limit: z.coerce.number().int().min(1).max(STORE_PAGE_SIZES.max).default(STORE_PAGE_SIZES.default),
  cursor: cursor.optional(),
});
export type StoreProductsQuery = z.infer<typeof storeProductsQuerySchema>;

export const storeProductCardSchema = z.strictObject({
  slug: catalogueSlugSchema,
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
  slug: catalogueSlugSchema,
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
  /** From approved reviews only (step 95); null while none is approved. */
  rating: storeRatingSchema.nullable(),
  /** The newest approved reviews. */
  reviews: z.array(storeReviewSchema).max(STORE_REVIEWS_SHOWN),
});
export type StoreProductResponse = z.infer<typeof storeProductResponseSchema>;

// --- Search (roadmap step 60) ---
export const STORE_SEARCH_SORTS = ["relevance", ...STORE_PRODUCT_SORTS] as const;
export type StoreSearchSort = (typeof STORE_SEARCH_SORTS)[number];

/** One value or a repeated parameter, as a bounded list without duplicates. */
const list = <T extends z.ZodType>(item: T, max: number) =>
  z
    .union([item, z.array(item).min(1).max(max)])
    .transform((value) => [...new Set(Array.isArray(value) ? value : [value])] as z.infer<T>[]);
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const fils = z.coerce.number().int().min(0).max(1_000_000_000);
const puffs = z.coerce.number().int().min(1).max(1_000_000);
/** Text a shopper typed. Bounded here; reduced to letters and digits before it reaches SQL. */
const searchText = z.string().max(200);

export const storeSearchQuerySchema = z
  .strictObject({
    q: searchText.optional(),
    type: z.enum(["disposable", "kit"]).optional(),
    brand: list(catalogueSlugSchema, 10).optional(),
    minPriceFils: fils.optional(),
    maxPriceFils: fils.optional(),
    minPuffs: puffs.optional(),
    maxPuffs: puffs.optional(),
    /** Values of the "nicotine" option, as stored on variants (for example "20 mg"). */
    nicotine: list(z.string().trim().min(1).max(40), 6).optional(),
    inStock: flag.optional(),
    onSale: flag.optional(),
    /** Defaults to relevance when there is a search term, otherwise newest. */
    sort: z.enum(STORE_SEARCH_SORTS).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(STORE_PAGE_SIZES.max)
      .default(STORE_PAGE_SIZES.default),
    cursor: cursor.optional(),
  })
  .refine((value) => (value.minPriceFils ?? 0) <= (value.maxPriceFils ?? Infinity), {
    path: ["maxPriceFils"],
    message: "Invalid field",
  })
  .refine((value) => (value.minPuffs ?? 0) <= (value.maxPuffs ?? Infinity), {
    path: ["maxPuffs"],
    message: "Invalid field",
  });
export type StoreSearchQuery = z.infer<typeof storeSearchQuerySchema>;

const facetCount = z.number().int().min(0);
/**
 * Facet counts say how many products each choice would give. Each facet is counted with every
 * OTHER filter applied and its own ignored, so the choices inside one facet stay visible while
 * one of them is selected. `total` counts the products matching every filter.
 */
export const storeSearchResponseSchema = z.strictObject({
  /** The normalized term that was searched ("" when browsing with filters only). */
  query: z.string(),
  /** True when nothing matched the words as typed and near misses are shown instead. */
  approximate: z.boolean(),
  sort: z.enum(STORE_SEARCH_SORTS),
  total: facetCount,
  items: z.array(storeProductCardSchema).max(STORE_PAGE_SIZES.max),
  nextCursor: z.string().nullable(),
  facets: z.strictObject({
    types: z
      .array(z.strictObject({ type: z.enum(["disposable", "kit"]), count: facetCount }))
      .max(2),
    brands: z
      .array(z.strictObject({ slug: z.string(), name: z.string(), count: facetCount }))
      .max(200),
    puffCounts: z
      .array(z.strictObject({ puffCount: z.number().int().positive(), count: facetCount }))
      .max(100),
    nicotine: z.array(z.strictObject({ value: z.string(), count: facetCount })).max(50),
    /** Lowest and highest price among the products the other filters leave. */
    price: z.strictObject({ minFils: productFilsSchema, maxFils: productFilsSchema }).nullable(),
    inStock: facetCount,
    onSale: facetCount,
  }),
});
export type StoreSearchResponse = z.infer<typeof storeSearchResponseSchema>;

export const storeSuggestQuerySchema = z.strictObject({ q: searchText });
export const storeSuggestResponseSchema = z.strictObject({
  query: z.string(),
  products: z
    .array(z.strictObject({ slug: z.string(), name: z.string(), brandName: z.string() }))
    .max(6),
  brands: z.array(z.strictObject({ slug: z.string(), name: z.string() })).max(4),
});
export type StoreSuggestResponse = z.infer<typeof storeSuggestResponseSchema>;

// --- Device cart refresh (roadmap step 62) ---
export const STORE_CART_MAX_LINES = ORDER_LIMITS.maxLines;
/** Variant IDs held in the shopper's device cart; one value or a repeated parameter. */
export const storeCartLinesQuerySchema = z.strictObject({
  variant: list(z.uuid(), STORE_CART_MAX_LINES),
});
export type StoreCartLinesQuery = z.infer<typeof storeCartLinesQuerySchema>;
/**
 * Current display data for the variants that can still be shown. A requested variant that is
 * missing from `lines` is no longer available (deactivated, unpublished or removed): the cart
 * says so and never replaces it. Prices are a preview; the quote decides what is charged.
 */
export const storeCartLinesResponseSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        productSlug: catalogueSlugSchema,
        name: z.string(),
        brand: z.string(),
        /** Option values in the product's option order, e.g. "grape ice · 20 mg". */
        options: z.string(),
        priceFils: productFilsSchema,
        compareAtPriceFils: productFilsSchema.nullable(),
        available: z.boolean(),
        image: storeImageSchema.nullable(),
      }),
    )
    .max(STORE_CART_MAX_LINES),
});
export type StoreCartLinesResponse = z.infer<typeof storeCartLinesResponseSchema>;
export type StoreCartLine = StoreCartLinesResponse["lines"][number];

// --- Device lists: saved items and recently viewed (roadmap step 63) ---
export const STORE_CARDS_MAX = 24;
export const storeProductCardsQuerySchema = z.strictObject({
  slug: list(catalogueSlugSchema, STORE_CARDS_MAX),
});
export type StoreProductCardsQuery = z.infer<typeof storeProductCardsQuerySchema>;
/**
 * Cards for product slugs a device has remembered. `requested` is the slug that was asked for;
 * `card.slug` is the current one (they differ after a rename). A requested slug with no item is
 * no longer available to shoppers.
 */
export const storeProductCardsResponseSchema = z.strictObject({
  items: z
    .array(z.strictObject({ requested: catalogueSlugSchema, card: storeProductCardSchema }))
    .max(STORE_CARDS_MAX),
});
export type StoreProductCardsResponse = z.infer<typeof storeProductCardsResponseSchema>;

// --- Store info for the shell (roadmap step 64) ---
/**
 * The few Owner settings a shopper's pages need. `whatsappNumber` is null until the Owner has
 * configured it (business input BI-09); the storefront then shows no WhatsApp links at all.
 */
export const storeInfoResponseSchema = z.strictObject({
  whatsappNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .nullable(),
  /** Whether orders are being taken (step 80). The order route decides again on every order. */
  checkoutOpen: z.boolean(),
});
export type StoreInfoResponse = z.infer<typeof storeInfoResponseSchema>;

// --- Delivery choices for the checkout form (roadmap step 70) ---
/**
 * Active delivery areas and the one flat fee. `feeFils` and `etaText` are null until the Owner
 * has configured delivery. `freeThresholdFils` is always null at launch: free delivery is off
 * and the storefront shows no progress towards it.
 */
export const storeDeliveryResponseSchema = z.strictObject({
  feeFils: z.number().int().min(0).max(1_000_000_000).nullable(),
  etaText: z.string().nullable(),
  freeThresholdFils: z.null(),
  areas: z
    .array(z.strictObject({ id: z.uuid(), name: z.string(), emirate: z.enum(UAE_EMIRATES) }))
    .max(500),
});
export type StoreDeliveryResponse = z.infer<typeof storeDeliveryResponseSchema>;

// --- Cart quote (roadmap step 71, ADR 0041) ---
/**
 * What a shopper asks a price for: lines, a delivery area and at most one code. There is no
 * field for a price, a fee or a discount, and unknown fields are refused.
 */
export const storeQuoteRequestSchema = z.strictObject({
  lines: orderLinesSchema,
  areaId: z.uuid(),
  couponCode: couponCodeInputSchema,
});
export type StoreQuoteRequest = z.input<typeof storeQuoteRequestSchema>;
/**
 * The authoritative total and the token that says the shopper saw it. Amounts are integer
 * fils. `insufficientStock` names lines that cannot be filled right now; nothing is reserved.
 * No stock number, version or internal reference appears.
 */
export const storeQuoteResponseSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.number().int().min(1),
        unitPriceFils: productFilsSchema,
        subtotalFils: z.number().int().min(0),
        discountFils: z.number().int().min(0),
        totalFils: z.number().int().min(0),
      }),
    )
    .max(ORDER_LIMITS.maxLines),
  merchandiseSubtotalFils: z.number().int().min(0),
  discountFils: z.number().int().min(0),
  deliveryFeeFils: z.number().int().min(0),
  totalFils: z.number().int().min(0),
  freeDeliveryThresholdFils: z.null(),
  delivery: z.strictObject({
    areaId: z.uuid(),
    areaName: z.string(),
    emirate: z.enum(UAE_EMIRATES),
    etaText: z.string(),
  }),
  coupon: z.strictObject({ code: z.string(), percentBps: z.number().int() }).nullable(),
  insufficientStock: z.array(z.uuid()).max(ORDER_LIMITS.maxLines),
  quote: z.strictObject({
    /** Sent back unchanged when placing the order; opaque to the client. */
    token: z.string().max(256),
    fingerprint: z.string().max(64),
    expiresAt: z.iso.datetime(),
  }),
});
export type StoreQuoteResponse = z.infer<typeof storeQuoteResponseSchema>;

// --- Order submission (roadmap step 77, ADR 0046) ---
/**
 * What a shopper sends to place an order: who and where, the lines, at most one code, the token
 * of the total they accepted and the second 18+ confirmation. There is no field for a price, a
 * fee, a discount or a total. The attempt key travels in the `Idempotency-Key` header.
 */
export const storeOrderRequestSchema = z.strictObject({
  contact: checkoutContactSchema,
  address: checkoutAddressSchema,
  lines: orderLinesSchema,
  couponCode: couponCodeInputSchema,
  quoteToken: z.string().min(1).max(256),
  /** The shopper ticked "I am 18 or older" on the checkout form. Only `true` is an order. */
  ageConfirmed: z.literal(true),
});
export type StoreOrderRequest = z.input<typeof storeOrderRequestSchema>;
/**
 * The answer for a placed order, given again unchanged when the same attempt is retried.
 * Nothing personal and nothing that grants access: the order number is a display reference.
 */
export const storeOrderResponseSchema = z.strictObject({
  orderNumber: z.string().max(32),
  totalFils: z.number().int().min(0),
  placedAt: z.iso.datetime(),
});
export type StoreOrderResponse = z.infer<typeof storeOrderResponseSchema>;

/** Cookie-authorized confirmation snapshots; excludes customer identity, phone, notes and internal IDs. */
export const orderConfirmationResponseSchema = z.strictObject({
  orderNumber: z.string().regex(/^IH-[0-9]{6,}$/),
  placedAt: z.iso.datetime(),
  status: z.enum([
    "pending",
    "confirmed",
    "processing",
    "out_for_delivery",
    "delivered",
    "cancelled",
  ]),
  totalFils: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deliveryFeeFils: z.number().int().nonnegative(),
  discountFils: z.number().int().nonnegative(),
  etaText: z.string().max(500),
  address: z.strictObject({
    area: z.string().max(100),
    emirate: z.string().max(32),
    type: z.enum(["apartment", "villa", "office"]),
    building: z.string().max(200),
    unit: z.string().max(100).nullable(),
    street: z.string().max(200).nullable(),
  }),
  items: z
    .array(
      z.strictObject({
        name: z.string().max(150),
        attributes: z.record(z.string(), z.string()),
        quantity: z.number().int().positive(),
        unitPriceFils: z.number().int().nonnegative(),
        totalFils: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(100),
});
export type OrderConfirmationResponse = z.infer<typeof orderConfirmationResponseSchema>;

export const orderConfirmationQuerySchema = z.strictObject({});

// --- Published home content (step 98, ADR 0066) ---
/** A link inside the store, resolved from the content's IDs to the current slug. */
const homeHref = z
  .string()
  .regex(/^\/(shop|categories\/[a-z0-9-]{1,120}|brands\/[a-z0-9-]{1,120}|p\/[a-z0-9-]{1,120})$/);
const homeLinkSchema = z.strictObject({ label: z.string().min(1).max(30), href: homeHref });
const homeBannerSchema = z.strictObject({
  title: z.string().min(1).max(60),
  subtitle: z.string().max(160).nullable(),
  cta: homeLinkSchema.nullable(),
  image: storeImageSchema.nullable(),
});
/**
 * `GET /v1/store/content/home`: the published home sections, assembled. Only published copies;
 * anything a shopper cannot see is already left out. A disabled or unpublished section is
 * null (or empty), and the page simply does not show it.
 */
export const storeHomeResponseSchema = z.strictObject({
  ticker: z.strictObject({ messages: z.array(z.string().min(1).max(90)).min(1).max(6) }).nullable(),
  hero: homeBannerSchema.extend({ eyebrow: z.string().max(40).nullable() }).nullable(),
  featured: z.array(storeProductCardSchema).max(8),
  bestSellers: z.array(storeProductCardSchema).max(8),
  brands: z
    .array(
      z.strictObject({ name: z.string(), slug: z.string(), productCount: z.number().int().min(0) }),
    )
    .max(24),
  banners: z.array(homeBannerSchema).max(2),
  offers: z
    .strictObject({
      title: z.string().min(1).max(60),
      products: z.array(storeProductCardSchema).max(6),
    })
    .nullable(),
});
export type StoreHomeResponse = z.infer<typeof storeHomeResponseSchema>;
