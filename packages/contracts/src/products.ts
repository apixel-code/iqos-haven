import { z } from "zod";
import { catalogueSeoSchema, catalogueSlugSchema, catalogueText } from "./catalogue";

/**
 * Admin product contracts (roadmap step 44). Money is integer fils; decimal spec values are
 * strings with a fixed pattern (never floats). Variants/SKU (45), stock (46–47), images (48–50)
 * and publication/trash (51) arrive in their own steps.
 */
const version = z.number().int().min(1).max(2147483646);
export const productFilsSchema = z.number().int().min(0).max(1_000_000_000);
const shortText = (max: number) => catalogueText(1, max);
const decimal = (pattern: RegExp) => z.string().regex(pattern);

/** Free-form rows shown under the typed specifications. */
const extraSpecs = z
  .array(z.strictObject({ label: shortText(40), value: shortText(120) }))
  .max(12)
  .default([]);
export const disposableSpecsSchema = z.strictObject({
  liquidMl: decimal(/^\d{1,2}(\.\d)?$/).optional(),
  batteryMah: z.number().int().min(1).max(20_000).optional(),
  rechargeable: z.boolean().optional(),
  charging: shortText(60).optional(),
  extra: extraSpecs,
});
export const kitSpecsSchema = z.strictObject({
  batteryMah: z.number().int().min(1).max(20_000).optional(),
  maxOutputW: z.number().int().min(1).max(500).optional(),
  podCapacityMl: decimal(/^\d{1,2}(\.\d)?$/).optional(),
  coilOhm: decimal(/^\d(\.\d{1,2})?$/).optional(),
  charging: shortText(60).optional(),
  display: shortText(60).optional(),
  inTheBox: shortText(300).optional(),
  extra: extraSpecs,
});

const common = {
  name: shortText(150),
  slug: catalogueSlugSchema,
  brandId: z.uuid(),
  categoryId: z.uuid(),
  basePriceFils: productFilsSchema,
  /** A "was" price; must be above the base price. */
  compareAtPriceFils: productFilsSchema.nullable(),
  description: catalogueText(0, 5_000),
  isNew: z.boolean(),
  /** Omit unless the caller holds `seo.write`. */
  seo: catalogueSeoSchema.optional(),
};
const typed = [
  z.strictObject({
    ...common,
    type: z.literal("disposable"),
    /** Approximate puffs; required before a disposable can be published. */
    puffCount: z.number().int().min(1).max(1_000_000).nullable(),
    specs: disposableSpecsSchema,
  }),
  z.strictObject({
    ...common,
    type: z.literal("kit"),
    puffCount: z.null(),
    specs: kitSpecsSchema,
  }),
] as const;
const comparePrice = (value: { basePriceFils: number; compareAtPriceFils: number | null }) =>
  value.compareAtPriceFils === null || value.compareAtPriceFils > value.basePriceFils;
const compareIssue = { message: "Must be above the base price", path: ["compareAtPriceFils"] };

export const productCreateRequestSchema = z
  .discriminatedUnion("type", typed)
  .refine(comparePrice, compareIssue);
export const productUpdateRequestSchema = z
  .discriminatedUnion("type", [typed[0].extend({ version }), typed[1].extend({ version })])
  .refine(comparePrice, compareIssue);

const reference = z.strictObject({ id: z.uuid(), name: z.string() });
export const productResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  brand: reference,
  category: reference,
  type: z.enum(["disposable", "kit"]),
  puffCount: z.number().int().nullable(),
  status: z.enum(["draft", "published"]),
  basePriceFils: productFilsSchema,
  compareAtPriceFils: productFilsSchema.nullable(),
  /** Unused: prices are final as entered (BI-02, ADR 0036). Always null; kept for compatibility. */
  taxTreatment: z.strictObject({ ref: z.string(), version: z.number().int() }).nullable(),
  specs: z.union([disposableSpecsSchema, kitSpecsSchema]),
  description: z.string(),
  isNew: z.boolean(),
  /** Present only for callers holding `seo.write`. */
  seo: catalogueSeoSchema.optional(),
  version: z.number().int().positive(),
  trashedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/** Products list sorts (parity G-A8): newest first, name, or base price either way. */
export const PRODUCT_SORTS = ["newest", "name", "price_asc", "price_desc"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
/**
 * A product's stock at a glance (parity G-A8), over its active options: `out` when none is in
 * stock, `low` when one is out or at or below its alert level, otherwise `in_stock`.
 */
export const PRODUCT_STOCK_STATES = ["in_stock", "low", "out"] as const;
export const productSummarySchema = productResponseSchema
  .pick({
    id: true,
    name: true,
    slug: true,
    brand: true,
    category: true,
    type: true,
    status: true,
    basePriceFils: true,
    isNew: true,
    version: true,
    trashedAt: true,
    updatedAt: true,
  })
  .extend({
    /** Only for callers holding `inventory.read` (stripped by the route's field policy). */
    stock: z
      .strictObject({
        onHand: z.number().int().min(0),
        state: z.enum(PRODUCT_STOCK_STATES),
      })
      .optional(),
    /** Short-lived signed link to the main image's thumbnail, or none. */
    thumbnailUrl: z.url().nullable(),
  });
export const productsQuerySchema = z.strictObject({
  status: z.enum(["all", "draft", "published", "trashed"]).default("all"),
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  /** Product name or option SKU. */
  q: z.string().trim().min(1).max(100).optional(),
  stock: z.enum(PRODUCT_STOCK_STATES).optional(),
  sort: z.enum(PRODUCT_SORTS).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque keyset position for the chosen sort (a bare id is a newest-first one). */
  after: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const productParamsSchema = z.strictObject({ id: z.uuid() });
export const productsResponseSchema = z.strictObject({
  items: z.array(productSummarySchema).max(100),
  nextCursor: z.string().max(300).nullable(),
});

export type DisposableSpecs = z.infer<typeof disposableSpecsSchema>;
export type KitSpecs = z.infer<typeof kitSpecsSchema>;
export type ProductCreateRequest = z.input<typeof productCreateRequestSchema>;
export type ProductUpdateRequest = z.input<typeof productUpdateRequestSchema>;
export type ProductResponse = z.infer<typeof productResponseSchema>;
export type ProductSummary = z.infer<typeof productSummarySchema>;
export type ProductsQuery = z.input<typeof productsQuerySchema>;

// --- Publication, trash and purge (step 51, ADR 0021) ---
/** Publish, unpublish, trash, restore and purge all name the version the user saw. */
export const productStateRequestSchema = z.strictObject({ version });
export const PUBLISH_REQUIREMENTS = [
  "active_variant",
  "default_variant",
  "image",
  "description",
  "price",
  "puff_count",
  "live_brand_category",
  "not_trashed",
] as const;
export const productReadinessSchema = z.strictObject({
  productId: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "published"]),
  ready: z.boolean(),
  missing: z.array(z.enum(PUBLISH_REQUIREMENTS)),
});
export type ProductStateRequest = z.infer<typeof productStateRequestSchema>;
export type ProductReadiness = z.infer<typeof productReadinessSchema>;
export type PublishRequirement = (typeof PUBLISH_REQUIREMENTS)[number];
export const productPurgeResponseSchema = z.strictObject({
  purged: z.literal(true),
  storageObjects: z.number().int().min(0),
  /** Private objects whose deletion failed (logged; bucket lifecycle is the backstop). */
  failedDeletes: z.number().int().min(0),
});
