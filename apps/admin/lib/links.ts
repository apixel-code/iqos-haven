/**
 * Deep links inside the admin (parity G-A2, ADR 0081). Each screen reads its own query
 * parameter: `orders?order=`, `?status=`, `?delayed=1`; `products?product=`;
 * `inventory?variant=`, `?state=`; `customers?customer=`; `orders?new=1`, `products?new=1`. Only
 * UUIDs are put into a link, never free text.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string | null | undefined): value is string =>
  typeof value === "string" && UUID.test(value);

export const orderHref = (id: string) => `/workspace/orders?order=${id}`;
export const ordersHref = (filter: { status?: string; delayed?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.delayed) params.set("delayed", "1");
  return params.size ? `/workspace/orders?${params}` : "/workspace/orders";
};
export const productHref = (id: string) => `/workspace/products?product=${id}`;
/** Opens the manual order form or a new product draft (the dashboard's quick actions). */
export const newOrderHref = "/workspace/orders?new=1";
export const newProductHref = "/workspace/products?new=1";
export const variantStockHref = (id: string) => `/workspace/inventory?variant=${id}`;

/** Where a notification's stored link (an API-side path) leads in this admin. */
export function notificationDestination(
  link: string | null,
): { href: string; label: string } | null {
  if (!link) return null;
  const order = /^\/orders\/([^/]+)$/.exec(link)?.[1];
  if (order !== undefined)
    return isUuid(order)
      ? { href: orderHref(order), label: "Open order" }
      : { href: "/workspace/orders", label: "Open orders" };
  const variant = /^\/inventory\/([^/]+)$/.exec(link)?.[1];
  if (variant !== undefined)
    return isUuid(variant)
      ? { href: variantStockHref(variant), label: "Open stock" }
      : { href: "/workspace/inventory", label: "Open inventory" };
  if (link === "/reviews") return { href: "/workspace/reviews", label: "Open reviews" };
  return null;
}
