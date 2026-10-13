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
