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
