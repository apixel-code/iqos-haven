import { z } from "zod";
import { COUPON_STATUSES, InvalidCouponCodeError, normalizeCouponCode } from "@ih/domain";

/**
 * The coupon a shopper typed: exactly one code (no list, so no stacking), returned normalized.
 * Absent, null or blank means "no coupon".
 */
export const couponCodeInputSchema = z
  .string()
  .max(64)
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value.trim() === "") return null;
    try {
      return normalizeCouponCode(value);
    } catch (error) {
      if (!(error instanceof InvalidCouponCodeError)) throw error;
      ctx.addIssue({ code: "custom", message: "Enter a valid code" });
      return z.NEVER;
    }
  });
/**
 * Stable error codes of the store API (architecture §7). The detailed reason (unknown, inactive,
 * expired, …) is deliberately not part of any contract: it would reveal which codes exist.
 */
export const COUPON_INVALID = "COUPON_INVALID";
export const COUPON_LIMIT_REACHED = "COUPON_LIMIT_REACHED";

// --- Owner coupon administration (roadmap step 69, ADR 0039) ---
const version = z.number().int().min(1).max(2147483646);
const instant = z.iso.datetime().nullable();
/** Percentage only: there is no field for a fixed amount, a brand or a product. */
const terms = {
  /** Basis points: 1500 = 15 %. */
  percentBps: z.number().int().min(1).max(10_000),
  minSubtotalFils: z.number().int().min(0).max(1_000_000_000),
  startsAt: instant,
  expiresAt: instant,
  active: z.boolean(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable(),
};
const window = (value: { startsAt: string | null; expiresAt: string | null }) =>
  !value.startsAt || !value.expiresAt || Date.parse(value.expiresAt) > Date.parse(value.startsAt);
const windowIssue = { path: ["expiresAt"], message: "The end must be after the start" };
export const couponCreateRequestSchema = z
  .strictObject({
    /** Fixed once created. Stored in upper case. */
    code: z
      .string()
      .max(64)
      .transform((value, ctx) => {
        try {
          return normalizeCouponCode(value);
        } catch (error) {
          if (!(error instanceof InvalidCouponCodeError)) throw error;
          ctx.addIssue({
            code: "custom",
            message: "Use 3 to 32 letters, digits, hyphens or underscores",
          });
          return z.NEVER;
        }
      }),
    ...terms,
  })
  .refine(window, windowIssue);
/** Replaces every editable term; names the version the Owner saw. */
export const couponUpdateRequestSchema = z
  .strictObject({ version, ...terms })
  .refine(window, windowIssue);
export const couponStateRequestSchema = z.strictObject({ version });
export const couponParamsSchema = z.strictObject({ id: z.uuid() });
export const couponsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.uuid().optional(),
  /** Query text, or the already-parsed boolean when the schema is applied a second time. */
  trashed: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
});
export const couponStatusSchema = z.enum(COUPON_STATUSES);
export const couponResponseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  percentBps: z.number().int(),
  minSubtotalFils: z.number().int(),
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  active: z.boolean(),
  usageLimit: z.number().int().nullable(),
  /** Orders currently holding a use (released ones are not counted). */
  activeRedemptions: z.number().int().min(0),
  status: couponStatusSchema,
  version: z.number().int().positive(),
  trashedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const couponsResponseSchema = z.strictObject({
  items: z.array(couponResponseSchema).max(100),
  nextCursor: z.uuid().nullable(),
});
export type CouponCreateRequest = z.input<typeof couponCreateRequestSchema>;
export type CouponUpdateRequest = z.infer<typeof couponUpdateRequestSchema>;
export type CouponStateRequest = z.infer<typeof couponStateRequestSchema>;
export type CouponsQuery = z.input<typeof couponsQuerySchema>;
export type CouponResponse = z.infer<typeof couponResponseSchema>;
