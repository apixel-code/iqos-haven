/**
 * Low-stock transition rule (architecture §6 "Inventory and low stock", ADR 0023). A variant is
 * low when its stock is at or below its threshold; with the default threshold 0 that is sold out.
 */
export interface StockLevel {
  readonly stock: number;
  readonly threshold: number;
}

export function isLowStock(level: StockLevel): boolean {
  return level.stock <= level.threshold;
}

/**
 * True exactly when a change moves a variant from above its threshold to at or below it. Either
 * side may change: a stock movement or an edited threshold. A variant that was already low never
 * crosses again until it has been above the threshold (re-arm), so further sales, a second
 * threshold edit or a partial restock that stays low emit nothing.
 */
export function crossedIntoLowStock(before: StockLevel, after: StockLevel): boolean {
  return !isLowStock(before) && isLowStock(after);
}
