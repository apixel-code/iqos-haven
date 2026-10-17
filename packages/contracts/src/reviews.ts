import { z } from "zod";

/**
 * Reviews and verified-purchase proof (roadmap step 93, ADR 0061). A proof is a 256-bit random
 * token, base64url without padding (43 characters). Staff create it for a Delivered order and
 * send the link themselves; it never travels in a query string.
 */
export const REVIEW_PROOF_TTL_DAYS = 30;
export const reviewProofTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /v1/admin/orders/:id/review-link`: shown once; the token is not stored in clear. */
export const reviewLinkResponseSchema = z.strictObject({
  orderId: z.uuid(),
  /** `https://<store domain>/review#<token>`: the token stays in the fragment. */
  link: z.url(),
  expiresAt: z.iso.datetime(),
  /** Products of the order not reviewed yet. */
  products: z.number().int().min(1),
  /** A ready WhatsApp message to the order's customer; staff send it themselves. */
  whatsapp: z
    .strictObject({ href: z.url(), text: z.string().min(1).max(2000), placeholder: z.boolean() })
    .nullable(),
});
export type ReviewLinkResponse = z.infer<typeof reviewLinkResponseSchema>;

export const reviewRatingSchema = z.number().int().min(1).max(5);
export const reviewStatusSchema = z.enum(["pending", "approved", "rejected"]);

/**
 * Characters a review may not hold: controls, and invisible or direction-changing marks that
 * could hide or reorder text. ZWNJ and ZWJ (U+200C/D) stay allowed: Arabic and Persian names
 * and emoji sequences need them.
 */
const HIDDEN = "\\p{Cc}\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF";
/** One line of visible text: no control characters, outer spaces trimmed. */
const line = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .regex(new RegExp(`^[^${HIDDEN}]*$`, "u")),
    );
/** Paragraphs: line breaks kept (at most one blank line in a row), other controls refused. */
const paragraphs = (min: number, max: number) =>
  z
    .string()
    .transform((value) =>
      value
        .normalize("NFC")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .regex(new RegExp(`^(?:[^${HIDDEN}]|\\n)*$`, "u")),
    );

/**
 * `POST /v1/store/reviews/proof` (step 94): what a review link may be used for. The token
 * travels in the body only, never in a URL.
 */
export const storeReviewProofRequestSchema = z.strictObject({ token: reviewProofTokenSchema });
export const storeReviewProofResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  /** The products left to review: ID and catalogue name, nothing about the order. */
  products: z
    .array(z.strictObject({ productId: z.uuid(), name: z.string().min(1).max(200) }))
    .min(1),
});
export type StoreReviewProofResponse = z.infer<typeof storeReviewProofResponseSchema>;

export const REVIEW_TITLE_MAX = 120;
export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 2000;
export const REVIEW_AUTHOR_MAX = 60;
/** `POST /v1/store/reviews` (step 94): one review of one product the link covers. */
export const storeReviewRequestSchema = z.strictObject({
  token: reviewProofTokenSchema,
  productId: z.uuid(),
  rating: reviewRatingSchema,
  title: line(REVIEW_TITLE_MAX),
  body: paragraphs(REVIEW_BODY_MIN, REVIEW_BODY_MAX),
  authorName: line(REVIEW_AUTHOR_MAX),
});
export type StoreReviewRequest = z.infer<typeof storeReviewRequestSchema>;
/** A submitted review waits for moderation; nothing is published by submitting. */
export const storeReviewResponseSchema = z.strictObject({
  status: z.literal("pending"),
  /** Products the link can still be used for. */
  remaining: z.number().int().min(0),
});
export type StoreReviewResponse = z.infer<typeof storeReviewResponseSchema>;

// --- Moderation (step 95, ADR 0063) ---
const reviewCursor = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_-]+$/);
/** `GET /v1/admin/reviews`: newest first; no status means every status. */
export const adminReviewsQuerySchema = z.strictObject({
  status: reviewStatusSchema.optional(),
  productId: z.uuid().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: reviewCursor.optional(),
});
export type AdminReviewsQuery = z.infer<typeof adminReviewsQuerySchema>;
export const adminReviewSchema = z.strictObject({
  id: z.uuid(),
  status: reviewStatusSchema,
  rating: reviewRatingSchema,
  title: z.string().min(1).max(REVIEW_TITLE_MAX),
  body: z.string().min(1).max(REVIEW_BODY_MAX),
  authorName: z.string().min(1).max(REVIEW_AUTHOR_MAX),
  product: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(200) }),
  /** Derived from the stored purchase proof, never supplied: every launch review has one. */
  verified: z.boolean(),
  /** The order behind the proof, only for a moderator who may also read orders. */
  order: z.strictObject({ id: z.uuid(), orderNumber: z.string() }).optional(),
  createdAt: z.iso.datetime(),
  moderatedAt: z.iso.datetime().nullable(),
  version: z.number().int().min(1),
});
export type AdminReview = z.infer<typeof adminReviewSchema>;
export const adminReviewsResponseSchema = z.strictObject({
  items: z.array(adminReviewSchema).max(100),
  nextCursor: reviewCursor.nullable(),
  /** Counts per status, for the tabs (not narrowed by product or rating). */
  counts: z.strictObject({
    pending: z.number().int().min(0),
    approved: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }),
  /** Average of approved reviews, one decimal; null while none is approved. */
  approvedAverage: z.number().min(1).max(5).nullable(),
  /** Products that have reviews, for the filter. */
  products: z.array(z.strictObject({ id: z.uuid(), name: z.string().min(1).max(200) })).max(500),
});
export type AdminReviewsResponse = z.infer<typeof adminReviewsResponseSchema>;
export const adminReviewParamsSchema = z.strictObject({ id: z.uuid() });
/** Approve shows a review on its product page; reject hides it (also after approval). */
export const reviewModerationRequestSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  expectedVersion: z.number().int().min(1),
});
export type ReviewModerationRequest = z.infer<typeof reviewModerationRequestSchema>;
export const reviewModerationResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(["approved", "rejected"]),
  version: z.number().int().min(2),
  moderatedAt: z.iso.datetime(),
});
export type ReviewModerationResponse = z.infer<typeof reviewModerationResponseSchema>;

// --- Public (step 95) ---
/** What a product page shows: approved reviews only. */
export const storeReviewSchema = z.strictObject({
  rating: reviewRatingSchema,
  title: z.string().min(1).max(REVIEW_TITLE_MAX),
  body: z.string().min(1).max(REVIEW_BODY_MAX),
  authorName: z.string().min(1).max(REVIEW_AUTHOR_MAX),
  /** Calendar date (Dubai) the review was written. */
  date: z.iso.date(),
  verified: z.boolean(),
});
export const STORE_REVIEWS_SHOWN = 10;
export const storeRatingSchema = z.strictObject({
  /** One decimal, from approved reviews. */
  average: z.number().min(1).max(5),
  count: z.number().int().min(1),
  /** Approved reviews with 5, 4, 3, 2 and 1 stars, in that order. */
  distribution: z.tuple([
    z.number().int().min(0),
    z.number().int().min(0),
    z.number().int().min(0),
    z.number().int().min(0),
    z.number().int().min(0),
  ]),
});
export type StoreRating = z.infer<typeof storeRatingSchema>;
export type StoreReview = z.infer<typeof storeReviewSchema>;
