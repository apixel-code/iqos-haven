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
  /** Approved VAT/excise treatment (BI-02); read-only until treatments exist (step 67). */
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
export const productSummarySchema = productResponseSchema.pick({
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
  updatedAt: true,
});
export const productsQuerySchema = z.strictObject({
  status: z.enum(["all", "draft", "published"]).default("all"),
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Keyset over id descending (UUIDv7: newest first). */
  after: z.uuid().optional(),
});
export const productParamsSchema = z.strictObject({ id: z.uuid() });
export const productsResponseSchema = z.strictObject({
  items: z.array(productSummarySchema).max(100),
  nextCursor: z.uuid().nullable(),
});

export type DisposableSpecs = z.infer<typeof disposableSpecsSchema>;
export type KitSpecs = z.infer<typeof kitSpecsSchema>;
export type ProductCreateRequest = z.input<typeof productCreateRequestSchema>;
export type ProductUpdateRequest = z.input<typeof productUpdateRequestSchema>;
export type ProductResponse = z.infer<typeof productResponseSchema>;
export type ProductSummary = z.infer<typeof productSummarySchema>;
export type ProductsQuery = z.input<typeof productsQuerySchema>;
