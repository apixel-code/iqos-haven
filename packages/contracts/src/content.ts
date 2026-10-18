import { z } from "zod";

/**
 * Storefront content sections (roadmap step 96, ADR 0064). Seven fixed home sections, each a
 * JSON document validated by its schema at a schema version. Text is plain text, never HTML;
 * links point inside the store by ID; images are processed media assets with alt text. A
 * stored document says which schema version wrote it, so an old published copy stays readable
 * when a section's schema moves on.
 */
export const CONTENT_SECTION_KEYS = [
  "ticker",
  "hero",
  "featured",
  "best_sellers",
  "brands",
  "campaign_banner",
  "offers",
] as const;
export type ContentSectionKey = (typeof CONTENT_SECTION_KEYS)[number];
export const contentSectionKeySchema = z.enum(CONTENT_SECTION_KEYS);

/** Characters content may not hold: controls and invisible or direction-changing marks. */
const HIDDEN =
  "\\p{Cc}\\u00AD\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}";
/** One line of plain text, trimmed; angle brackets are refused so nothing reads as markup. */
const text = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .regex(new RegExp(`^[^${HIDDEN}<>]*$`, "u")),
    );
/** Optional text: null or blank is stored as null. */
const optionalText = (max: number) =>
  text(0, max)
    .nullable()
    .transform((value) => value || null);
const ids = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((list) => new Set(list).size === list.length, "Each item once");

/** Where a button goes: a store page, by ID so a renamed slug still resolves. */
export const contentLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shop") }),
  z.strictObject({ kind: z.literal("category"), categoryId: z.uuid() }),
  z.strictObject({ kind: z.literal("brand"), brandId: z.uuid() }),
  z.strictObject({ kind: z.literal("product"), productId: z.uuid() }),
]);
export type ContentLink = z.infer<typeof contentLinkSchema>;
const ctaSchema = z.strictObject({ label: text(1, 30), link: contentLinkSchema });
/** A processed content image (`media_assets.purpose = 'content'`) and its description. */
export const contentImageSchema = z.strictObject({ assetId: z.uuid(), alt: text(1, 125) });

export const TICKER_MESSAGES = { min: 2, max: 6, length: 90 } as const;
const tickerV1 = z.strictObject({
  enabled: z.boolean(),
  /** Scroll right to left, in this order. */
  messages: z
    .array(text(1, TICKER_MESSAGES.length))
    .min(TICKER_MESSAGES.min)
    .max(TICKER_MESSAGES.max),
});
/** Version 1: one hero (before ADR 0097). Still read for copies saved or published at v1. */
const heroV1 = z.strictObject({
  eyebrow: optionalText(40),
  title: text(1, 60),
  subtitle: optionalText(160),
  cta: ctaSchema.nullable(),
  image: contentImageSchema.nullable(),
});
/**
 * Version 2 (ADR 0097, Marina 2026-10-18): the storefront prototype's carousel, one to three
 * slides, each in one of the prototype's three looks (navy, lilac, coral), with an optional
 * second button; one slide shows no dots or arrows.
 */
export const HERO_SLIDES_MAX = 3;
/** The prototype's slide looks: navy and coral carry light text, lilac dark text. */
export const HERO_STYLES = ["navy", "lilac", "coral"] as const;
export const heroSlideSchema = z.strictObject({
  style: z.enum(HERO_STYLES),
  eyebrow: optionalText(40),
  title: text(1, 60),
  subtitle: optionalText(160),
  cta: ctaSchema.nullable(),
  secondaryCta: ctaSchema.nullable(),
  image: contentImageSchema.nullable(),
});
const heroV2 = z.strictObject({ slides: z.array(heroSlideSchema).min(1).max(HERO_SLIDES_MAX) });
export const FEATURED_MAX = 8;
const featuredV1 = z.strictObject({ productIds: ids(FEATURED_MAX) });
export const BEST_SELLERS_COUNT = 8;
/** Automatic: top products by units sold in the last 30 days. Manual: the list, in order. */
const bestSellersV1 = z
  .strictObject({ mode: z.enum(["auto", "manual"]), productIds: ids(BEST_SELLERS_COUNT) })
  .refine((value) => value.mode === "manual" || value.productIds.length === 0, {
    message: "Automatic mode keeps no list",
    path: ["productIds"],
  });
export const BRANDS_MAX = 24;
const brandsV1 = z.strictObject({ brandIds: ids(BRANDS_MAX) });
const bannerV1 = z.strictObject({
  enabled: z.boolean(),
  title: text(1, 60),
  subtitle: optionalText(120),
  cta: ctaSchema.nullable(),
  image: contentImageSchema.nullable(),
});
export const CAMPAIGN_BANNERS_MAX = 2;
const campaignBannerV1 = z.strictObject({
  banners: z.array(bannerV1).max(CAMPAIGN_BANNERS_MAX),
});
export const OFFERS_MAX = 6;
/** Products to highlight. Showing coupon codes in public is not decided (BI-13): not stored. */
const offersV1 = z.strictObject({
  enabled: z.boolean(),
  title: text(1, 60),
  productIds: ids(OFFERS_MAX),
});

/** Every schema version of every section. Add a version; never change a released one. */
export const CONTENT_SCHEMAS = {
  ticker: { 1: tickerV1 },
  hero: { 1: heroV1, 2: heroV2 },
  featured: { 1: featuredV1 },
  best_sellers: { 1: bestSellersV1 },
  brands: { 1: brandsV1 },
  campaign_banner: { 1: campaignBannerV1 },
  offers: { 1: offersV1 },
} as const satisfies Record<ContentSectionKey, Record<number, z.ZodType>>;
/** The version a new draft is written at. */
export const CURRENT_CONTENT_SCHEMA = {
  ticker: 1,
  hero: 2,
  featured: 1,
  best_sellers: 1,
  brands: 1,
  campaign_banner: 1,
  offers: 1,
} as const satisfies Record<ContentSectionKey, number>;
type CurrentSchemas = {
  [K in ContentSectionKey]: (typeof CONTENT_SCHEMAS)[K][(typeof CURRENT_CONTENT_SCHEMA)[K] &
    keyof (typeof CONTENT_SCHEMAS)[K]];
};
/** A section's document at the current version. */
export type ContentOf<K extends ContentSectionKey> = z.output<CurrentSchemas[K]>;
export type SectionContent = { [K in ContentSectionKey]: ContentOf<K> }[ContentSectionKey];

export class ContentSchemaError extends Error {}

/**
 * A validated document read at its stored version, in the current version's shape: what the
 * editor shows and the store renders. Hero v1 becomes one navy slide without a second button.
 */
export function upgradeContent(key: ContentSectionKey, version: number, content: unknown): unknown {
  if (key === "hero" && version === 1) {
    const hero = content as z.output<typeof heroV1>;
    return { slides: [{ style: "navy", ...hero, secondaryCta: null }] };
  }
  return content;
}
/** The schema for a stored or submitted document, or an error for an unknown version. */
export function contentSchema(key: ContentSectionKey, version: number): z.ZodType<SectionContent> {
  const schema = (CONTENT_SCHEMAS[key] as Record<number, z.ZodType<SectionContent> | undefined>)[
    version
  ];
  if (!schema) throw new ContentSchemaError(`No schema ${key}@${version}`);
  return schema;
}

/** Everything a section points at, to be checked against the catalogue and media. */
export interface ContentReferences {
  productIds: string[];
  brandIds: string[];
  categoryIds: string[];
  assetIds: string[];
}
/** The references of a validated document, each ID once, in first-seen order. */
export function contentReferences(content: SectionContent): ContentReferences {
  const found = {
    productIds: new Set<string>(),
    brandIds: new Set<string>(),
    categoryIds: new Set<string>(),
    assetIds: new Set<string>(),
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "productIds" || key === "brandIds")
        (item as string[]).forEach((id) => found[key].add(id));
      else if (key === "productId" || key === "brandId" || key === "categoryId")
        found[`${key}s` as keyof typeof found].add(item as string);
      else if (key === "assetId") found.assetIds.add(item as string);
      else visit(item);
    }
  };
  visit(content);
  return {
    productIds: [...found.productIds],
    brandIds: [...found.brandIds],
    categoryIds: [...found.categoryIds],
    assetIds: [...found.assetIds],
  };
}

/** What an unknown reference was, for the editor. */
export const contentProblemSchema = z.strictObject({
  kind: z.enum(["product", "brand", "category", "image"]),
  id: z.uuid(),
  reason: z.enum(["missing", "not_visible", "not_ready"]),
});
export type ContentProblem = z.infer<typeof contentProblemSchema>;

// --- Editor API (step 97, ADR 0065) ---
/** One section as the editor sees it; null fields for a section never saved. */
export const adminContentSectionSchema = z.strictObject({
  key: contentSectionKeySchema,
  /** 0 until the first save. */
  version: z.number().int().min(0),
  schemaVersion: z.number().int().min(1),
  draft: z.record(z.string(), z.unknown()).nullable(),
  draftUpdatedAt: z.iso.datetime().nullable(),
  published: z.record(z.string(), z.unknown()).nullable(),
  publishedAt: z.iso.datetime().nullable(),
  unpublishedChanges: z.boolean(),
});
export type AdminContentSection = z.infer<typeof adminContentSectionSchema>;
export const adminContentResponseSchema = z.strictObject({
  sections: z.array(adminContentSectionSchema).length(CONTENT_SECTION_KEYS.length),
});
export const contentKeyParamsSchema = z.strictObject({ key: contentSectionKeySchema });
/** The document is checked against the section's schema by the route. */
export const contentDraftRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  content: z.record(z.string(), z.unknown()),
});
export const contentPublishRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

/** What the draft points at, resolved for the editor's preview (never public). */
export const contentPreviewResponseSchema = z.strictObject({
  key: contentSectionKeySchema,
  version: z.number().int().min(1),
  problems: z.array(contentProblemSchema).max(100),
  products: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        visible: z.boolean(),
        soldOut: z.boolean(),
        priceFromFils: z.number().int().min(0).nullable(),
      }),
    )
    .max(100),
  brands: z
    .array(z.strictObject({ id: z.uuid(), name: z.string(), visible: z.boolean() }))
    .max(100),
  categories: z
    .array(z.strictObject({ id: z.uuid(), name: z.string(), visible: z.boolean() }))
    .max(100),
  images: z
    .array(z.strictObject({ id: z.uuid(), ready: z.boolean(), url: z.url().nullable() }))
    .max(10),
});
export type ContentPreviewResponse = z.infer<typeof contentPreviewResponseSchema>;

/** A content image for the editor's picker; `url` is a short-lived signed preview. */
export const contentImageItemSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(["pending", "uploaded", "processing", "ready", "rejected", "expired"]),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  error: z.string().nullable(),
  url: z.url().nullable(),
  createdAt: z.iso.datetime(),
});
export const contentImagesResponseSchema = z.strictObject({
  items: z.array(contentImageItemSchema).max(60),
});
export type ContentImageItem = z.infer<typeof contentImageItemSchema>;
