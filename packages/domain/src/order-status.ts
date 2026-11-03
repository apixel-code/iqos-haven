/**
 * Order lifecycle (architecture Rev 2): six states.
 * Delivered never implies cash collected — collection is a separate explicit command.
 */
export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["out_for_delivery", "cancelled"],
  // Post-handoff cancellation = Owner-only return flow (roadmap step 86).
  out_for_delivery: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Cancelling after handoff to the courier needs Owner permission and return handling. */
export function isPostHandoffCancellation(from: OrderStatus, to: OrderStatus): boolean {
  return from === "out_for_delivery" && to === "cancelled";
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export const ORDER_SOURCES = ["storefront", "manual"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
/** Cash on delivery. New orders are pending; a cancelled order is not_collected. */
export const COD_STATUSES = ["pending", "collected", "not_collected"] as const;
export type CodStatus = (typeof COD_STATUSES)[number];
/** The status an order may be created in: the store creates pending; staff may enter confirmed. */
export function initialStatuses(source: OrderSource): readonly OrderStatus[] {
  return source === "manual" ? ["pending", "confirmed"] : ["pending"];
}
/** Whether items, address and coupon may still be edited (architecture §6). */
export function isEditable(status: OrderStatus): boolean {
  return status === "pending" || status === "confirmed";
}
export const FIRST_ORDER_NUMBER = 1001;
/**
 * Order numbers are random 12-digit numbers from ADR 0104 (Marina 2026-11-03), assigned by the
 * database, so the order number alone can track an order. The orders placed before that kept
 * their sequential numbers (`IH-001001`…), which can be guessed, so they are never trackable.
 */
export const RANDOM_ORDER_NUMBER = { min: 100_000_000_000, max: 999_999_999_999 } as const;
/** Whether a number is one of the random ones (ADR 0104), the only ones tracking accepts. */
export function isTrackableOrderNumber(orderNumber: number): boolean {
  return (
    Number.isSafeInteger(orderNumber) &&
    orderNumber >= RANDOM_ORDER_NUMBER.min &&
    orderNumber <= RANDOM_ORDER_NUMBER.max
  );
}
/** The number people say and search for, e.g. `IH-482193057316` (before ADR 0104 `IH-001001`). */
export function formatOrderNumber(orderNumber: number | bigint | string): string {
  // The database driver hands a bigint column over as a string of digits.
  if (typeof orderNumber === "string" && !/^\d{1,18}$/.test(orderNumber))
    throw new RangeError("Not an order number");
  if (typeof orderNumber === "number" && !Number.isSafeInteger(orderNumber))
    throw new RangeError("Not an order number");
  const value = BigInt(orderNumber);
  if (value < BigInt(FIRST_ORDER_NUMBER)) throw new RangeError("Not an order number");
  return "IH-" + value.toString().padStart(6, "0");
}
/**
 * Accepts what a person types: `IH-001001`, `ih 1001`, `#1001`, `1001`, and a long number with
 * spaces or dashes between its digits (`IH 4821 9305 7316`). Null when it is none.
 */
export function parseOrderNumber(input: string): number | null {
  const match = /^\s*(?:IH[-\s]?|#)?(\d[\d -]{0,30}\d|\d)\s*$/i.exec(
    typeof input === "string" ? input : "",
  );
  const digits = match?.[1]!.replace(/[ -]/g, "").replace(/^0+(?=\d)/, "");
  if (!digits || !/^\d{4,15}$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= FIRST_ORDER_NUMBER ? value : null;
}
