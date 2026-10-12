import { applyBasisPoints, fils, type Fils } from "./money";
import { MAX_DISCOUNT_BASIS_POINTS } from "./pricing";

/**
 * Launch coupon policy (roadmap step 68, ADR 0038): one percentage code per order, applied to
 * merchandise only. Minimum spend is tested on the merchandise subtotal before the discount;
 * the start and expiry are tested against the server's clock.
 */
export class InvalidCouponCodeError extends Error {}
const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
/** Codes are compared in upper case with surrounding space removed; nothing else is changed. */
export function normalizeCouponCode(input: string): string {
  const code = typeof input === "string" && input.length <= 64 ? input.trim().toUpperCase() : "";
  if (!COUPON_CODE.test(code)) throw new InvalidCouponCodeError();
  return code;
}
export const COUPON_REJECTIONS = [
  "UNKNOWN",
  "INACTIVE",
  "NOT_STARTED",
  "EXPIRED",
  "MINIMUM_NOT_MET",
  "LIMIT_REACHED",
] as const;
export type CouponRejection = (typeof COUPON_REJECTIONS)[number];
export interface CouponTerms {
  percentBps: number;
  minSubtotalFils: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
  usageLimit: number | null;
  activeRedemptions: number;
}
/**
 * Why a coupon cannot be used right now, or `null` when it can. The order is fixed so the same
 * situation always gives the same reason. `expiresAt` is exclusive: at that instant it is over.
 */
export function couponRejection(
  coupon: CouponTerms | null,
  now: Date,
  merchandiseSubtotalFils: number,
): CouponRejection | null {
  if (!Number.isSafeInteger(merchandiseSubtotalFils) || merchandiseSubtotalFils < 0)
    throw new RangeError("Merchandise subtotal must be a non-negative integer number of fils");
  if (!coupon) return "UNKNOWN";
  if (!coupon.active) return "INACTIVE";
  if (coupon.startsAt && now.getTime() < coupon.startsAt.getTime()) return "NOT_STARTED";
  if (coupon.expiresAt && now.getTime() >= coupon.expiresAt.getTime()) return "EXPIRED";
  if (merchandiseSubtotalFils < coupon.minSubtotalFils) return "MINIMUM_NOT_MET";
  if (coupon.usageLimit !== null && coupon.activeRedemptions >= coupon.usageLimit)
    return "LIMIT_REACHED";
  return null;
}
/** The order discount of a percentage coupon: half-up, once, on merchandise. */
export function couponDiscount(merchandiseSubtotalFils: number, percentBps: number): Fils {
  if (!Number.isSafeInteger(percentBps) || percentBps < 1 || percentBps > MAX_DISCOUNT_BASIS_POINTS)
    throw new RangeError("Coupon percentage must be 1 to 10000 basis points");
  return applyBasisPoints(fils(merchandiseSubtotalFils), percentBps);
}
export const COUPON_STATUSES = [
  "trashed",
  "inactive",
  "scheduled",
  "expired",
  "used_up",
  "live",
] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];
/** What the Owner sees for a coupon right now; `live` means an order could use it. */
export function couponStatus(coupon: CouponTerms, now: Date, trashed: boolean): CouponStatus {
  if (trashed) return "trashed";
  const reason = couponRejection({ ...coupon, minSubtotalFils: 0 }, now, 0);
  if (reason === "INACTIVE") return "inactive";
  if (reason === "NOT_STARTED") return "scheduled";
  if (reason === "EXPIRED") return "expired";
  if (reason === "LIMIT_REACHED") return "used_up";
  return "live";
}
