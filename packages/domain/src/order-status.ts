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
 * The number people say and search for, e.g. `IH-001001`. Sequential, assigned by the database;
 * it identifies an order but grants no access to it.
 */
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
/** Accepts what a person types: `IH-001001`, `ih 1001`, `#1001`, `1001`. Null when it is none. */
export function parseOrderNumber(input: string): number | null {
  const match = /^\s*(?:IH[-\s]?|#)?0*(\d{4,15})\s*$/i.exec(typeof input === "string" ? input : "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= FIRST_ORDER_NUMBER ? value : null;
}
