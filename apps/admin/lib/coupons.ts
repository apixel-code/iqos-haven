import {
  couponCreateRequestSchema,
  couponUpdateRequestSchema,
  type CouponResponse,
} from "@ih/contracts";
import { aedToFils, filsToAed, FormValidationError, validate } from "./management";

/** "15" or "12.5" to basis points, from the text. A floating-point percentage is never used. */
export function percentToBps(value: string): number {
  const text = value.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text))
    throw new FormValidationError("Enter a percentage such as 15 or 12.5.");
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bps < 1 || bps > 10_000)
    throw new FormValidationError("The percentage must be above 0 and at most 100.");
  return bps;
}
export function bpsToPercent(bps: number): string {
  const fraction = bps % 100;
  return `${Math.floor(bps / 100)}${fraction ? "." + String(fraction).padStart(2, "0").replace(/0$/, "") : ""}`;
}
/** A `datetime-local` value (this device's time zone) to an ISO instant; blank is "none". */
export function localToIso(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new FormValidationError("Enter a valid date and time.");
  return date.toISOString();
}
export function isoToLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function limit(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d{1,7}$/.test(value.trim()))
    throw new FormValidationError("Enter the usage limit as a whole number, or leave it blank.");
  return Number(value.trim());
}
const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
function terms(data: FormData) {
  return {
    percentBps: percentToBps(text(data, "percent")),
    minSubtotalFils: text(data, "minimum") ? aedToFils(text(data, "minimum")) : 0,
    startsAt: localToIso(text(data, "startsAt")),
    expiresAt: localToIso(text(data, "expiresAt")),
    active: data.get("active") === "on",
    usageLimit: limit(text(data, "usageLimit")),
  };
}
export function couponCreateCommand(data: FormData) {
  return validate(couponCreateRequestSchema, { code: text(data, "code"), ...terms(data) });
}
export function couponUpdateCommand(version: number, data: FormData) {
  return validate(couponUpdateRequestSchema, { version, ...terms(data) });
}
const STATUS_LABELS: Record<CouponResponse["status"], string> = {
  live: "Live",
  inactive: "Inactive",
  scheduled: "Scheduled",
  expired: "Ended",
  used_up: "Used up",
  trashed: "In Trash",
};
export const couponStatusLabel = (status: CouponResponse["status"]) => STATUS_LABELS[status];
/** One plain sentence saying what the coupon does, so the Owner can check it before saving. */
export function couponSentence(coupon: CouponResponse): string {
  const minimum =
    coupon.minSubtotalFils > 0
      ? ` on orders of AED ${filsToAed(coupon.minSubtotalFils)} or more of products`
      : " on any order";
  const uses =
    coupon.usageLimit === null
      ? `${coupon.activeRedemptions} used, no limit`
      : `${coupon.activeRedemptions} of ${coupon.usageLimit} used`;
  return `${bpsToPercent(coupon.percentBps)}% off products${minimum}. Delivery is not discounted. ${uses}.`;
}
