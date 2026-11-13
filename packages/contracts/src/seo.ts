import { z } from "zod";

/**
 * SEO (roadmap step 113, ADR 0079; architecture §9). The indexing policy is the Owner's choice:
 * a closed store (nothing offered to crawlers, the default), the public policy pages only, or
 * the whole catalogue (ADR 0114, client decision 2026-11-13): verified search crawlers read the
 * catalogue pages without the age check, and the sitemap and JSON-LD name products.
 */
export const SEO_INDEXING = ["closed", "public_pages", "catalogue"] as const;
export const seoPolicySchema = z.strictObject({ indexing: z.enum(SEO_INDEXING) });
export type SeoPolicy = z.infer<typeof seoPolicySchema>;

/** Public answer the storefront's robots, sitemap and policy pages read (no ticket needed). */
export const publicSeoPolicySchema = seoPolicySchema;

export const seoPolicyWriteRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  indexing: z.enum(SEO_INDEXING),
});
export type SeoPolicyWriteRequest = z.infer<typeof seoPolicyWriteRequestSchema>;

const feature = z.strictObject({
  key: z.enum([
    "generic_previews",
    "base_canonical",
    "slug_redirects",
    "public_sitemap",
    "product_indexing",
    "product_previews",
    "product_json_ld",
  ]),
  label: z.string(),
  state: z.enum(["active", "inactive"]),
  /** Why it is in this state, in plain words. */
  note: z.string(),
});
export const seoOverviewSchema = z.strictObject({
  policy: seoPolicySchema,
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
  features: z.array(feature).max(10),
});
export type SeoOverview = z.infer<typeof seoOverviewSchema>;

/** One problem with a published page's SEO fields. */
export const SEO_ISSUE_KINDS = [
  "missing_title",
  "missing_description",
  "title_too_long",
  "description_too_long",
  "duplicate_title",
] as const;
export const seoIssuesResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  /** Recommended lengths the "too long" issues use. */
  limits: z.strictObject({ title: z.number().int(), description: z.number().int() }),
  counts: z.record(z.enum(SEO_ISSUE_KINDS), z.number().int().min(0)),
  checked: z.strictObject({
    products: z.number().int().min(0),
    brands: z.number().int().min(0),
    categories: z.number().int().min(0),
  }),
  items: z
    .array(
      z.strictObject({
        kind: z.enum(SEO_ISSUE_KINDS),
        entity: z.enum(["product", "brand", "category"]),
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        /** The value at fault (a title or its length), never more than the field itself. */
        detail: z.string().max(200).nullable(),
      }),
    )
    .max(200),
});
export type SeoIssuesResponse = z.infer<typeof seoIssuesResponseSchema>;
