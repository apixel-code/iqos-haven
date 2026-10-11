import { z } from "zod";
import { catalogueText } from "./catalogue";
import { productFilsSchema } from "./products";

/**
 * Product options and variants (roadmap step 45, ADR 0016). Launch options are flavour,
 * nicotine and colour; values are stored canonical (trimmed, lower-case) as the DB requires.
 * A product without options has exactly one variant with no attributes. Stock is read-only here:
 * every change goes through the stock ledger (steps 46–47).
 */
export const OPTION_NAMES = ["flavour", "nicotine", "colour"] as const;
const version = z.number().int().min(1).max(2147483646);
const optionValue = catalogueText(1, 100).transform((value) => value.toLowerCase());
export const productOptionSchema = z.strictObject({
  name: z.enum(OPTION_NAMES),
  values: z
    .array(optionValue)
    .min(1)
    .max(50)
    .refine((values) => new Set(values).size === values.length, "Values must be unique"),
});
/** Replaces the whole option set; guarded by the product version (options are product data). */
export const productOptionsWriteRequestSchema = z.strictObject({
  productVersion: version,
  options: z
    .array(productOptionSchema)
    .max(OPTION_NAMES.length)
    .refine(
      (options) => new Set(options.map((option) => option.name)).size === options.length,
      "Each option once",
    ),
});

export const variantSkuSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/));
const attributes = z.partialRecord(z.enum(OPTION_NAMES), optionValue);
export const variantCreateRequestSchema = z.strictObject({
  sku: variantSkuSchema,
  /** Exactly one value per product option (empty for a product without options). */
  attributes,
  priceOverrideFils: productFilsSchema.nullable(),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
  active: z.boolean(),
});
/** Attributes are the variant's identity and never change; deactivate instead of deleting. */
export const variantUpdateRequestSchema = z.strictObject({
  version,
  sku: variantSkuSchema,
  priceOverrideFils: productFilsSchema.nullable(),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
  active: z.boolean(),
  /** `true` moves the default here; the current default cannot be unset directly. */
  isDefault: z.boolean(),
});

export const variantResponseSchema = z.strictObject({
  id: z.uuid(),
  sku: z.string(),
  attributes: z.record(z.string(), z.string()),
  priceOverrideFils: productFilsSchema.nullable(),
  /** Read-only balance maintained by the stock ledger. */
  stockOnHand: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0),
  active: z.boolean(),
  isDefault: z.boolean(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export const productVariantsResponseSchema = z.strictObject({
  productId: z.uuid(),
  productVersion: z.number().int().positive(),
  options: z.array(
    z.strictObject({ name: z.enum(OPTION_NAMES), values: z.array(z.string()).max(50) }),
  ),
  variants: z.array(variantResponseSchema).max(500),
});
export const productVariantParamsSchema = z.strictObject({ id: z.uuid(), variantId: z.uuid() });

export type ProductOptionsWriteRequest = z.input<typeof productOptionsWriteRequestSchema>;
export type VariantCreateRequest = z.input<typeof variantCreateRequestSchema>;
export type VariantUpdateRequest = z.input<typeof variantUpdateRequestSchema>;
export type VariantResponse = z.infer<typeof variantResponseSchema>;
export type ProductVariantsResponse = z.infer<typeof productVariantsResponseSchema>;
