import type { AdminOrderResponse } from "@ih/contracts";

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
export const COD_STATUS_LABELS: Record<string, string> = {
  pending: "Cash pending",
  collected: "Cash collected",
  not_collected: "Not collected",
};
export const money = (fils: number) =>
  new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(fils / 100);
/** "65", "65.5" or "65.50" AED as integer fils, or null. Parsed as text: no float arithmetic. */
export function aedToFils(text: string): number | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
/** A date-time input's value ("2026-10-14T12:05", browser time) as an ISO instant, or null. */
export function localInstant(text: string): string | null {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
/** An ISO instant as a date-time input's value, in browser time, to the minute. */
export function inputInstant(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const when = (value: string) =>
  new Intl.DateTimeFormat("en-AE", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
export const addressLine = (order: AdminOrderResponse) => {
  if (!order.customer) return "Customer contact is hidden for this permission set.";
  const a = order.customer.address;
  return [a.building, a.unit, a.street, order.area.name, order.area.emirate]
    .filter(Boolean)
    .join(", ");
};
