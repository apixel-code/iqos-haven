import type { StoreQuoteResponse } from "@ih/contracts";

/**
 * Server quote on the cart page (roadmap step 71, ADR 0041). The device cart only previews
 * prices; the total a shopper pays comes from the API. This module holds the small decisions
 * around it, free of React and of the network. Nothing here is stored on the device.
 */
export interface QuoteRequest {
  lines: Array<{ variantId: string; quantity: number }>;
  areaId: string;
  couponCode: string | null;
}
/** Identifies what the shopper asked a price for. Two equal requests have equal keys. */
export function requestKey(request: QuoteRequest): string {
  const lines = [...request.lines]
    .map((line) => `${line.variantId.toLowerCase()}x${line.quantity}`)
    .sort()
    .join(",");
  return `${request.areaId.toLowerCase()}|${(request.couponCode ?? "").trim().toUpperCase()}|${lines}`;
}
/** The total the shopper has seen and accepted, kept in memory only. */
export interface AcceptedQuote {
  requestKey: string;
  fingerprint: string;
  totalFils: number;
  token: string;
  expiresAt: string;
}
export const acceptedFrom = (key: string, quote: StoreQuoteResponse): AcceptedQuote => ({
  requestKey: key,
  fingerprint: quote.quote.fingerprint,
  totalFils: quote.totalFils,
  token: quote.quote.token,
  expiresAt: quote.quote.expiresAt,
});
/**
 * What a newly received quote means next to the one the shopper accepted:
 * - `first`: nothing was accepted yet, or the shopper changed the cart, area or code. The new
 *   total is the answer to their own action, so showing it is enough.
 * - `same`: the same request still costs the same. Only the token is refreshed.
 * - `changed`: the same request now costs something else (a price, the fee or the coupon
 *   changed on the server). The shopper must look at the new total and accept it.
 *
 * `droppedFrom` is the total the shopper had accepted with a code that the server has since
 * refused. The cart is then priced without the code, which is a different request, but the
 * shopper did not ask for it: a different total is still `changed`.
 */
export function compareQuotes(
  accepted: AcceptedQuote | null,
  key: string,
  quote: StoreQuoteResponse,
  droppedFrom: AcceptedQuote | null = null,
): "first" | "same" | "changed" {
  if (droppedFrom && droppedFrom.totalFils !== quote.totalFils) return "changed";
  if (!accepted || accepted.requestKey !== key) return "first";
  return accepted.fingerprint === quote.quote.fingerprint ? "same" : "changed";
}
/** Whether the shopper may go on with this quote: accepted, unexpired and fully in stock. */
export function canProceed(
  accepted: AcceptedQuote | null,
  key: string,
  quote: StoreQuoteResponse | null,
  now: number,
): boolean {
  return (
    !!quote &&
    !!accepted &&
    accepted.requestKey === key &&
    accepted.fingerprint === quote.quote.fingerprint &&
    quote.insufficientStock.length === 0 &&
    Date.parse(accepted.expiresAt) > now
  );
}
export type QuoteProblem =
  | "AREA_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE"
  | "COUPON_INVALID"
  | "COUPON_LIMIT_REACHED"
  | "RATE_LIMITED"
  | "AGE"
  | "FAILED";
/** Maps an API answer to the one thing the page should say. Unknown answers are a failure. */
export function quoteProblem(status: number, code: string | undefined): QuoteProblem {
  if (status === 429) return "RATE_LIMITED";
  if (status === 403) return "AGE";
  if (status === 409)
    for (const known of [
      "AREA_UNAVAILABLE",
      "VARIANT_UNAVAILABLE",
      "COUPON_INVALID",
      "COUPON_LIMIT_REACHED",
    ] as const)
      if (code === known) return known;
  return "FAILED";
}
export const QUOTE_MESSAGES: Record<QuoteProblem, string> = {
  AREA_UNAVAILABLE: "We can't deliver to that area right now. Choose another area.",
  VARIANT_UNAVAILABLE:
    "Something in your cart is no longer available. Remove it to see your total.",
  COUPON_INVALID: "That code can't be used on this order. Your total is shown without it.",
  COUPON_LIMIT_REACHED: "That code has been fully used. Your total is shown without it.",
  RATE_LIMITED: "Too many tries. Wait a minute and try again.",
  AGE: "Your age confirmation has expired. Reload the page to continue.",
  FAILED: "We couldn't work out your total just now. Try again.",
};
/** A refused coupon is dropped and the cart is priced again without it. */
export const dropsCoupon = (problem: QuoteProblem) =>
  problem === "COUPON_INVALID" || problem === "COUPON_LIMIT_REACHED";
