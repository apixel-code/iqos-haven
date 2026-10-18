import { z } from "zod";

/** Catalogue admin contracts (roadmap steps 42–43). Bounds mirror the step-41 DB checks. */
const version = z.number().int().min(1).max(2147483646);
export const catalogueSlugSchema = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
/** Trimmed text without NUL (PostgreSQL text/jsonb reject it). */
export const catalogueText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes("\0"), "Must not contain NUL");
const name = catalogueText(1, 150);
const description = catalogueText(0, 10_000);
const sortOrder = z.number().int().min(0).max(100_000);
/** SEO fields are Owner-only (`seo.write`) to read and write (architecture §11). */
export const catalogueSeoSchema = z.strictObject({
  title: catalogueText(1, 120).nullable(),
  description: catalogueText(1, 320).nullable(),
});

export const brandCreateRequestSchema = z.strictObject({
  name,
  slug: catalogueSlugSchema,
  description: description.default(""),
  active: z.boolean(),
  sortOrder: sortOrder.default(0),
  /** Omit unless the caller holds `seo.write`. */
  seo: catalogueSeoSchema.optional(),
  /** A ready catalogue image (parity G-A7); omitted or null means none. */
  logoAssetId: z.uuid().nullable().optional(),
});
/** Complete replacement of editable fields; `seo` and `logoAssetId` omitted mean unchanged. */
export const brandUpdateRequestSchema = z.strictObject({
  version,
  name,
  slug: catalogueSlugSchema,
  description,
  active: z.boolean(),
  sortOrder,
  seo: catalogueSeoSchema.optional(),
  logoAssetId: z.uuid().nullable().optional(),
});
export const brandStateRequestSchema = z.strictObject({ version });

export const brandResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  /** The brand's logo: a ready catalogue image (parity G-A7, ADR 0091), or none. */
  logoAssetId: z.uuid().nullable(),
  /** Present only for callers holding `seo.write`. */
  seo: catalogueSeoSchema.optional(),
  /** Live (non-trashed) published products using the brand; trash is refused while > 0. */
  publishedProductCount: z.number().int().min(0),
  version: z.number().int().positive(),
  trashedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/** Opaque keyset cursor over (sortOrder, id). */
const cursor = z
  .string()
  .regex(/^\d{1,6}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const brandsQuerySchema = z.strictObject({
  status: z.enum(["live", "trashed"]).default("live"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: cursor.optional(),
});
export const brandParamsSchema = z.strictObject({ id: z.uuid() });
export const brandsResponseSchema = z.strictObject({
  items: z.array(brandResponseSchema).max(100),
  nextCursor: cursor.nullable(),
});

export type CatalogueSeo = z.infer<typeof catalogueSeoSchema>;
export type BrandCreateRequest = z.input<typeof brandCreateRequestSchema>;
export type BrandUpdateRequest = z.infer<typeof brandUpdateRequestSchema>;
export type BrandStateRequest = z.infer<typeof brandStateRequestSchema>;
export type BrandResponse = z.infer<typeof brandResponseSchema>;
export type BrandsQuery = z.input<typeof brandsQuerySchema>;

/** Categories mirror brands without a description; their media is an image (step 48–50). */
export const categoryCreateRequestSchema = z.strictObject({
  name,
  slug: catalogueSlugSchema,
  active: z.boolean(),
  sortOrder: sortOrder.default(0),
  seo: catalogueSeoSchema.optional(),
  imageAssetId: z.uuid().nullable().optional(),
});
export const categoryUpdateRequestSchema = z.strictObject({
  version,
  name,
  slug: catalogueSlugSchema,
  active: z.boolean(),
  sortOrder,
  seo: catalogueSeoSchema.optional(),
  imageAssetId: z.uuid().nullable().optional(),
});
export const categoryStateRequestSchema = brandStateRequestSchema;
export const categoryResponseSchema = brandResponseSchema
  .omit({ description: true, logoAssetId: true })
  .extend({ imageAssetId: z.uuid().nullable() });
export const categoriesQuerySchema = brandsQuerySchema;
export const categoryParamsSchema = brandParamsSchema;
export const categoriesResponseSchema = z.strictObject({
  items: z.array(categoryResponseSchema).max(100),
  nextCursor: brandsResponseSchema.shape.nextCursor,
});
export type CategoryCreateRequest = z.input<typeof categoryCreateRequestSchema>;
export type CategoryUpdateRequest = z.infer<typeof categoryUpdateRequestSchema>;
export type CategoryResponse = z.infer<typeof categoryResponseSchema>;
export type CategoriesQuery = BrandsQuery;
export type CategoryStateRequest = BrandStateRequest;

// --- Brand logos, category images and purge (parity G-A7, ADR 0091) ---
/** Owner purge of a trashed brand or category with no products. */
export const parentPurgeResponseSchema = z.strictObject({ purged: z.literal(true) });
