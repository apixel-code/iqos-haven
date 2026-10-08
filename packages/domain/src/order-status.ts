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
