/** Caps applied before any price calculation. The device cart uses the same numbers. */
export const ORDER_LIMITS = { maxLines: 50, maxLineQuantity: 10 } as const;
export type OrderLinesProblem = "EMPTY" | "TOO_MANY_LINES" | "QUANTITY";
export class OrderLinesError extends Error {
  constructor(
    readonly problem: OrderLinesProblem,
    readonly variantId?: string,
  ) {
    super(problem);
  }
}
export interface OrderLine {
  variantId: string;
  quantity: number;
}
/**
 * Canonical lines of a quote or order: one line per variant (repeats are added together),
 * sorted by variant ID, which is also the variant lock order. Refuses instead of clamping.
 */
export function mergeOrderLines(lines: readonly OrderLine[]): OrderLine[] {
  if (lines.length === 0) throw new OrderLinesError("EMPTY");
  if (lines.length > ORDER_LIMITS.maxLines) throw new OrderLinesError("TOO_MANY_LINES");
  const merged = new Map<string, number>();
  for (const line of lines) {
    const variantId = line.variantId.toLowerCase();
    const quantity = (merged.get(variantId) ?? 0) + line.quantity;
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      quantity > ORDER_LIMITS.maxLineQuantity
    )
      throw new OrderLinesError("QUANTITY", variantId);
    merged.set(variantId, quantity);
  }
  return [...merged]
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
}
