import { mergeOrderLines, type OrderLine, type PricedLine } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { lockCouponForOrder, previewCoupon, type AppliedCoupon } from "./coupons";
import { lockDeliverySelection, readDeliverySelection, type DeliverySelection } from "./delivery";
import { lockOrderPrices, priceOrderLines, readOrderPrices, type OrderPriceLine } from "./pricing";
import { isUnitOfWork } from "./transaction";

/**
 * Quote assembly (roadmap step 70, ADR 0040): what a cart costs, delivered to an area, with at
 * most one coupon. Everything comes from server state: the client supplies variant IDs,
 * quantities, an area ID and a typed code, and nothing else. There is no tax line (ADR 0036).
 */
export interface QuoteInput {
  lines: readonly OrderLine[];
  areaId: string;
  /** One typed code, or null/blank for none. */
  couponCode?: string | null | undefined;
}
export interface QuoteLine extends PricedLine {
  productId: string;
  productVersion: number;
  variantVersion: number;
}
export interface Quote {
  lines: QuoteLine[];
  merchandiseSubtotalFils: number;
  discountFils: number;
  deliveryFeeFils: number;
  totalFils: number;
  /** Always null at launch: free delivery is off. */
  freeDeliveryThresholdFils: null;
  delivery: {
    areaId: string;
    areaCode: string;
    areaName: string;
    emirate: string;
    etaText: string;
    /** Versions of the area and of the fee/ETA configuration the quote was built from. */
    areaVersion: number;
    configurationVersion: number;
  };
  coupon: { couponId: string; code: string; percentBps: number; version: number } | null;
}
/** Two server calculations disagree. Cannot happen; never shown to a shopper as a reason. */
export class QuoteInvariantError extends Error {}
function assemble(
  delivery: DeliverySelection,
  prices: readonly OrderPriceLine[],
  coupon: AppliedCoupon | null,
): Quote {
  const priced = priceOrderLines(prices, {
    discountBasisPoints: coupon?.percentBps ?? 0,
    deliveryFeeFils: delivery.feeFils,
  });
  // The coupon and the order arithmetic must agree on the discount to the fil.
  if (coupon && coupon.discountFils !== priced.discountFils)
    throw new QuoteInvariantError("Coupon discount disagrees with the order arithmetic");
  const byVariant = new Map(prices.map((line) => [line.variantId, line]));
  return {
    lines: priced.lines.map((line) => {
      const source = byVariant.get(line.variantId)!;
      return {
        ...line,
        productId: source.productId,
        productVersion: source.productVersion,
        variantVersion: source.variantVersion,
      };
    }),
    merchandiseSubtotalFils: priced.merchandiseSubtotalFils,
    discountFils: priced.discountFils,
    deliveryFeeFils: priced.deliveryFeeFils,
    totalFils: priced.totalFils,
    freeDeliveryThresholdFils: delivery.freeThresholdFils,
    delivery: {
      areaId: delivery.areaId,
      areaCode: delivery.areaCode,
      areaName: delivery.areaName,
      emirate: delivery.emirate,
      etaText: delivery.etaText,
      areaVersion: delivery.areaVersion,
      configurationVersion: delivery.configurationVersion,
    },
    coupon: coupon
      ? {
          couponId: coupon.couponId,
          code: coupon.code,
          percentBps: coupon.percentBps,
          version: coupon.version,
        }
      : null,
  };
}
// At most 50 lines × 10 × 1,000,000,000 fils = 5e11: far inside the safe integer range.
const subtotal = (prices: readonly OrderPriceLine[]) =>
  prices.reduce((sum, line) => sum + line.unitPriceFils * line.quantity, 0);
const typed = (code: string | null | undefined) => (code && code.trim() !== "" ? code : null);
/**
 * A quote without locks, for showing a price. It reserves nothing: stock is not held for a
 * cart, and `insufficientStock` only names the lines that could not be filled right now.
 * Fails as a whole, in the order the order transaction would: area (`DeliveryUnavailableError`,
 * `DeliveryUnconfiguredError`), lines (`VariantUnavailableError`, `OrderLinesError`), coupon
 * (`CouponRejectedError`).
 */
export async function previewQuote(
  db: Database | Tx,
  input: QuoteInput,
): Promise<Quote & { insufficientStock: string[] }> {
  const lines = mergeOrderLines(input.lines);
  const delivery = await readDeliverySelection(db, input.areaId);
  const prices = await readOrderPrices(db, lines);
  const code = typed(input.couponCode);
  const coupon = code ? await previewCoupon(db, code, subtotal(prices)) : null;
  const short = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT v.id FROM unnest(${lines.map((line) => line.variantId)}::uuid[],
      ${lines.map((line) => line.quantity)}::int[]) AS wanted(id, quantity)
    JOIN variants v ON v.id=wanted.id
    WHERE v.stock_on_hand < wanted.quantity ORDER BY v.id`);
  return { ...assemble(delivery, prices, coupon), insufficientStock: short.map((row) => row.id) };
}
/**
 * The same quote inside the order transaction, taking the settings/area, catalogue and coupon
 * groups of the resource order in that order and holding them until commit. The caller has
 * already taken the idempotency claim, any existing order and the customer; it locks variants
 * for stock next and passes `appliedCoupon` to `redeemCoupon`.
 */
export async function lockQuoteForOrder(
  tx: Tx,
  input: QuoteInput,
): Promise<Quote & { appliedCoupon: AppliedCoupon | null }> {
  if (!isUnitOfWork(tx)) throw new Error("Locking a quote requires a unit of work");
  const lines = mergeOrderLines(input.lines);
  const delivery = await lockDeliverySelection(tx, input.areaId);
  const prices = await lockOrderPrices(tx, lines);
  const code = typed(input.couponCode);
  const appliedCoupon = code ? await lockCouponForOrder(tx, code, subtotal(prices)) : null;
  return { ...assemble(delivery, prices, appliedCoupon), appliedCoupon };
}
