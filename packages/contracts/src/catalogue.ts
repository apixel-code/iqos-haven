import { z } from "zod";

/** Catalogue admin contracts (roadmap steps 42–43). Bounds mirror the step-41 DB checks. */
const version = z.number().int().min(1).max(2147483646);
export const catalogueSlugSchema = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const name = z.string().trim().min(1).max(150);
const description = z.string().trim().max(10_000);
const sortOrder = z.number().int().min(0).max(100_000);
/** SEO fields are Owner-only (`seo.write`) to read and write (architecture §11). */
export const catalogueSeoSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).nullable(),
  description: z.string().trim().min(1).max(320).nullable(),
});

export const brandCreateRequestSchema = z.strictObject({
  name,
  slug: catalogueSlugSchema,
  description: description.default(""),
  active: z.boolean(),
  sortOrder: sortOrder.default(0),
  /** Omit unless the caller holds `seo.write`. */
  seo: catalogueSeoSchema.optional(),
});
/** Complete replacement of editable fields; `seo` omitted means unchanged. */
export const brandUpdateRequestSchema = z.strictObject({
  version,
  name,
  slug: catalogueSlugSchema,
  description,
  active: z.boolean(),
  sortOrder,
  seo: catalogueSeoSchema.optional(),
});
export const brandStateRequestSchema = z.strictObject({ version });

export const brandResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  logoKey: z.string().nullable(),
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
