import { z } from "zod";

/** Money on the wire: integer fils (AED × 100). Never a float. */
export const filsSchema = z.number().int().safe();

/** Standard error envelope returned by the implemented global API filter. */
export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    fields: z.array(z.strictObject({ path: z.string().max(200), message: z.string().max(200) })),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
/** Stable 409 reasons a client may act on; anything else stays the generic CONFLICT. */
export const CONFLICT_CODES = [
  "VERSION_CONFLICT",
  "INVALID_TRANSITION",
  "ORDER_NOT_EDITABLE",
  "NO_CHANGES",
  /** Delivered or already cancelled: the cancel command does not apply (step 86). */
  "ORDER_NOT_CANCELLABLE",
  /** A return must classify every line of the order, and only those, completely. */
  "RETURN_INCOMPLETE",
  /** Cash can be recorded only for a Delivered order whose cash is still pending (step 87). */
  "COLLECTION_NOT_ALLOWED",
  /** A correction needs a recorded collection to correct. */
  "NOT_COLLECTED",
  "DUPLICATE",
  "IN_USE",
  "TRASHED",
  "PARENT_UNAVAILABLE",
  "PUBLISH_REQUIREMENTS",
  "OPTIONS_IN_USE",
  "INVALID_COMBINATION",
  "DEFAULT_REQUIRED",
  "INSUFFICIENT_STOCK",
  "INITIAL_STOCK_EXISTS",
  "COMMAND_REUSED",
  "STOCK_LIMIT",
  "STOCK_CHANGED",
  "IMAGE_LIMIT",
  "UPLOAD_MISSING",
  "UPLOAD_EXPIRED",
  "MEDIA_NOT_READY",
  "ORDER_MISMATCH",
  "NOT_TRASHED",
  /** Store quote and checkout reasons (architecture §7). */
  "AREA_UNAVAILABLE",
  "VARIANT_UNAVAILABLE",
  "COUPON_INVALID",
  "COUPON_LIMIT_REACHED",
  "QUOTE_CHANGED",
  "QUOTE_EXPIRED",
  /** Idempotent commands (architecture §7). */
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "CHECKOUT_RECOVERY_REQUIRED",
  /** A coupon's usage limit cannot go below the uses orders currently hold. */
  "LIMIT_BELOW_USES",
  /** An active coupon cannot end in the past. */
  "ALREADY_EXPIRED",
  /** A review link is only for a Delivered order (step 93). */
  "REVIEW_NOT_ALLOWED",
  /** Every product of the order has been reviewed already. */
  "NOTHING_TO_REVIEW",
  /** The review link needs the store's domain in Settings. */
  "STORE_DOMAIN_REQUIRED",
  /** A review link that is unknown, replaced, expired, or no longer covers the product (step 94). */
  "REVIEW_PROOF_INVALID",
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];
/** 403 code of a store route reached without a valid age ticket (step 55). */
export const AGE_VERIFICATION_REQUIRED = "AGE_VERIFICATION_REQUIRED";

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export const dependencyStatusSchema = z.enum(["up", "down"]);

export const livenessResponseSchema = z.object({ status: z.literal("ok") });
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const readinessResponseSchema = z.object({
  status: healthStatusSchema,
  checks: z.object({ database: dependencyStatusSchema, queue: dependencyStatusSchema }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export * from "./events";
export * from "./auth";
export * from "./settings";
export * from "./delivery";
export * from "./catalogue";
export * from "./products";
export * from "./variants";
export * from "./inventory";
export * from "./media";
export * from "./store";
export * from "./customers";
export * from "./checkout";
export * from "./coupons";
export * from "./orders";
export * from "./notifications";
export * from "./reviews";
