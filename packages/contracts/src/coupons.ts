import { z } from "zod";
import { InvalidCouponCodeError, normalizeCouponCode } from "@ih/domain";

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
