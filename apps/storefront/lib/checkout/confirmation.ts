import {
  EMIRATE_NAMES,
  orderConfirmationResponseSchema,
  type OrderConfirmationResponse,
  type StoreOrderResponse,
} from "@ih/contracts";

/**
 * The order confirmation page (roadmap step 81, ADR 0050). The order is read from the API with
 * the confirmation cookie the browser already holds; this module decides what an answer means
 * and how the snapshot is worded. Nothing here is stored on the device.
 */
export type ConfirmationView =
  | { kind: "shown"; order: OrderConfirmationResponse }
  /** No valid access from this browser (never had it, or the 30 minutes are over). */
  | { kind: "expired" }
  /** The page could not ask just now; asking again is harmless. */
  | { kind: "failed"; limited: boolean };
export function confirmationView(status: number, body: unknown): ConfirmationView {
  if (status === 200) {
    const order = orderConfirmationResponseSchema.safeParse(body);
    return order.success
      ? { kind: "shown", order: order.data }
      : { kind: "failed", limited: false };
  }
  if (status === 401) return { kind: "expired" };
  return { kind: "failed", limited: status === 429 };
}

/**
 * The order just acknowledged by the API in this visit: number, total and time, which is all
 * the acknowledgement holds. Kept in memory so the page can still name the order if the
 * details cannot be shown. Gone on reload; never written to device storage.
 */
let placed: StoreOrderResponse | null = null;
export const rememberPlaced = (order: StoreOrderResponse): void => void (placed = order);
export const rememberedPlaced = (): StoreOrderResponse | null => placed;

export const STATUS_TEXT: Record<OrderConfirmationResponse["status"], string> = {
  pending: "Order received. We will confirm it shortly.",
  confirmed: "Confirmed. We are getting it ready.",
  processing: "Being prepared.",
  out_for_delivery: "Out for delivery.",
  delivered: "Delivered.",
  cancelled: "Cancelled.",
};
const TYPE_TEXT = { apartment: "Apartment", villa: "Villa", office: "Office / Hotel" } as const;
/** The delivery address as lines to read, most specific first. */
export function addressLines(address: OrderConfirmationResponse["address"]): string[] {
  const emirate =
    (EMIRATE_NAMES as Readonly<Record<string, string>>)[address.emirate] ?? address.emirate;
  return [
    [address.unit ? `${TYPE_TEXT[address.type]} ${address.unit}` : null, address.building]
      .filter(Boolean)
      .join(", "),
    address.street,
    `${address.area}, ${emirate}`,
  ].filter((line): line is string => !!line);
}
/** Option values of a line ("Grape · 20 mg"), in the order the API gives them. */
export const optionText = (attributes: Readonly<Record<string, string>>): string =>
  Object.values(attributes).filter(Boolean).join(" · ");
/**
 * The "Subtotal" row: what the items cost before the discount, from the three amounts the API
 * gives (total = subtotal − discount + delivery). No price is multiplied or summed here.
 */
export const subtotalFils = (order: OrderConfirmationResponse): number =>
  order.totalFils - order.deliveryFeeFils + order.discountFils;
/** "13 Oct 2026, 12:05" in UAE time, whatever the device is set to. */
export function placedText(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Dubai",
  }).format(new Date(iso));
}
