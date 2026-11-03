import {
  EMIRATE_NAMES,
  orderTrackingResponseSchema,
  type OrderTrackingResponse,
} from "@ih/contracts";

/**
 * Order tracking (ADR 0104): the shopper types the order number and the API answers with the
 * order's status. The number is sent in a POST body only, never in the address bar, and nothing
 * is kept on the device. This module decides what an answer means and how it is worded.
 */
export type TrackingView =
  | { kind: "shown"; order: OrderTrackingResponse }
  /** No trackable order has that number (or it is from before ADR 0104). */
  | { kind: "missing" }
  /** Too many tries from here; waiting is the only way on. */
  | { kind: "limited" }
  /** The page could not ask just now; asking again is harmless. */
  | { kind: "failed" };
export function trackingView(status: number, body: unknown): TrackingView {
  if (status === 200) {
    const order = orderTrackingResponseSchema.safeParse(body);
    return order.success ? { kind: "shown", order: order.data } : { kind: "failed" };
  }
  if (status === 404 || status === 400) return { kind: "missing" };
  if (status === 429) return { kind: "limited" };
  return { kind: "failed" };
}

type Status = OrderTrackingResponse["status"];
/** The road an order takes, in order; a cancelled order leaves it. */
export const TRACK_STEPS: ReadonlyArray<{ status: Exclude<Status, "cancelled">; title: string }> = [
  { status: "pending", title: "Order received" },
  { status: "confirmed", title: "Confirmed" },
  { status: "processing", title: "Being prepared" },
  { status: "out_for_delivery", title: "Out for delivery" },
  { status: "delivered", title: "Delivered" },
];
export const TRACK_HEADLINE: Record<Status, string> = {
  pending: "We have your order and will call you to confirm it.",
  confirmed: "Your order is confirmed. We are getting it ready.",
  processing: "Your order is being prepared.",
  out_for_delivery: "Your order is on its way. Have the cash ready.",
  delivered: "Your order was delivered. Thank you.",
  cancelled: "This order was cancelled.",
};
/**
 * Each step with the time it was reached, or null while it is ahead. A step the history skipped
 * (an order entered as confirmed) still counts as done once a later step is reached.
 */
export function trackSteps(order: OrderTrackingResponse) {
  const reached = new Map(order.timeline.map((step) => [step.status, step.at] as const));
  const at = TRACK_STEPS.findIndex((step) => step.status === order.status);
  const last =
    at >= 0
      ? at
      : Math.max(
          ...order.timeline.map((step) =>
            TRACK_STEPS.findIndex((road) => road.status === step.status),
          ),
        );
  return TRACK_STEPS.map((step, index) => ({
    ...step,
    done: index <= last,
    current: index === at,
    at: reached.get(step.status) ?? null,
  }));
}
/** "Dubai Marina, Dubai" from the order's area. */
export const areaText = (area: OrderTrackingResponse["area"]): string =>
  `${area.name}, ${(EMIRATE_NAMES as Readonly<Record<string, string>>)[area.emirate] ?? area.emirate}`;
