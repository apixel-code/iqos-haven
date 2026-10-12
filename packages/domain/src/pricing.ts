import { addFils, applyBasisPoints, fils, multiplyFils, type Fils } from "./money";
import { ORDER_LIMITS } from "./order-lines";

/**
 * Order arithmetic (roadmap step 67, ADR 0037). Integer fils only. The unit price is the final
 * price the Owner entered (ADR 0036): nothing here adds, extracts or shows a tax.
 */
export const MAX_UNIT_PRICE_FILS = 1_000_000_000;
export const MAX_DELIVERY_FEE_FILS = 1_000_000_000;
export const MAX_DISCOUNT_BASIS_POINTS = 10_000;

function whole(value: number, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${what} must be an integer from ${min} to ${max}`);
  return value;
}
/**
 * Splits `amount` across `weights` in proportion, so the parts add up to `amount` exactly.
 * Each part is rounded down and the fils left over go, one each, to the parts that lost the
 * largest fraction; equal fractions are settled by position, so the result is deterministic.
 */
export function allocateLargestRemainder(amount: number, weights: readonly number[]): number[] {
  whole(amount, 0, Number.MAX_SAFE_INTEGER, "Amount");
  for (const weight of weights) whole(weight, 0, Number.MAX_SAFE_INTEGER, "Weight");
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (amount === 0) return weights.map(() => 0);
  // More than the weights hold would give a line a share larger than the line itself.
  if (BigInt(amount) > total) throw new RangeError("Amount exceeds the total weight");
  const parts = weights.map((weight, index) => {
    const exact = BigInt(amount) * BigInt(weight);
    return { index, part: Number(exact / total), lost: exact % total };
  });
  let left = amount - parts.reduce((sum, item) => sum + item.part, 0);
  const byLoss = [...parts].sort((a, b) =>
    a.lost === b.lost ? a.index - b.index : a.lost > b.lost ? -1 : 1,
  );
  for (const item of byLoss) {
    if (left === 0) break;
    item.part += 1;
    left -= 1;
  }
  return parts.map((item) => item.part);
}

export interface PricingLineInput {
  variantId: string;
  quantity: number;
  /** Current server price of the variant. Never a value sent by the client. */
  unitPriceFils: number;
}
export interface PricingInput {
  lines: readonly PricingLineInput[];
  /** Percentage coupon in basis points (1500 = 15 %); 0 or absent for none. */
  discountBasisPoints?: number;
  deliveryFeeFils: number;
}
export interface PricedLine {
  variantId: string;
  quantity: number;
  unitPriceFils: Fils;
  subtotalFils: Fils;
  /** This line's share of the order discount (for reports); the shares add up to the discount. */
  discountFils: Fils;
  totalFils: Fils;
}
export interface PricedOrder {
  lines: PricedLine[];
  merchandiseSubtotalFils: Fils;
  discountFils: Fils;
  deliveryFeeFils: Fils;
  totalFils: Fils;
}
/**
 * Totals of an order. The discount applies to merchandise only, is rounded half-up once for
 * the whole order and then shared across lines; delivery is added after it and is never
 * discounted. Lines must already be merged (one per variant).
 */
export function priceOrder(input: PricingInput): PricedOrder {
  whole(input.lines.length, 1, ORDER_LIMITS.maxLines, "Line count");
  if (new Set(input.lines.map((line) => line.variantId)).size !== input.lines.length)
    throw new RangeError("Lines must be merged: one line per variant");
  const basisPoints = whole(
    input.discountBasisPoints ?? 0,
    0,
    MAX_DISCOUNT_BASIS_POINTS,
    "Discount basis points",
  );
  const deliveryFeeFils = fils(
    whole(input.deliveryFeeFils, 0, MAX_DELIVERY_FEE_FILS, "Delivery fee"),
  );
  const subtotals = input.lines.map((line) =>
    multiplyFils(
      fils(whole(line.unitPriceFils, 1, MAX_UNIT_PRICE_FILS, "Unit price")),
      whole(line.quantity, 1, ORDER_LIMITS.maxLineQuantity, "Quantity"),
    ),
  );
  const merchandiseSubtotalFils = addFils(...subtotals);
  const discountFils = applyBasisPoints(merchandiseSubtotalFils, basisPoints);
  const shares = allocateLargestRemainder(discountFils, subtotals);
  const lines = input.lines.map((line, index) => ({
    variantId: line.variantId,
    quantity: line.quantity,
    unitPriceFils: fils(line.unitPriceFils),
    subtotalFils: subtotals[index]!,
    discountFils: fils(shares[index]!),
    totalFils: fils(subtotals[index]! - shares[index]!),
  }));
  return {
    lines,
    merchandiseSubtotalFils,
    discountFils,
    deliveryFeeFils,
    totalFils: fils(merchandiseSubtotalFils - discountFils + deliveryFeeFils),
  };
}
