import { storeSettingsSchema, whatsappSettingsSchema } from "@ih/contracts";
import { formatOrderNumber } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";

/** What the shopper's order confirmation says (ADR 0102), loaded from the order's snapshots. */
/** One order line as both order emails list it, from the order's own snapshot. */
export interface OrderEmailItem {
  name: string;
  options: string;
  quantity: number;
  totalFils: number;
}
/** The order's lines, in a stable order, for the shopper's and the shop's order emails. */
export async function orderEmailItems(
  db: Database | Tx,
  orderId: string,
): Promise<OrderEmailItem[]> {
  const items = await db.$queryRaw<
    Array<{ name: string; attributes: unknown; quantity: number; totalFils: bigint }>
  >(Prisma.sql`
    SELECT product_name AS name, attributes, quantity, total_fils AS "totalFils"
    FROM order_items WHERE order_id=${orderId}::uuid ORDER BY product_name, sku`);
  return items.map((item) => ({
    name: item.name,
    options: Object.values(
      item.attributes && typeof item.attributes === "object" ? item.attributes : {},
    )
      .filter((part): part is string => typeof part === "string")
      .join(" · "),
    quantity: item.quantity,
    totalFils: Number(item.totalFils),
  }));
}

export interface CustomerOrderEmail {
  email: string;
  customerName: string;
  /** E.164, e.g. +971501234567. */
  phone: string;
  orderNumber: string;
  items: OrderEmailItem[];
  merchandiseSubtotalFils: number;
  discountFils: number;
  deliveryFeeFils: number;
  totalFils: number;
  areaName: string;
  deliveryEtaText: string;
  store: { name: string; domain: string | null; whatsappNumber: string | null };
}

/**
 * The confirmation for an order the shopper placed, or null when the order is missing. A null
 * `email` field never reaches here: an order without one has no confirmation event.
 */
export async function loadCustomerOrderEmail(
  db: Database,
  orderId: string,
): Promise<CustomerOrderEmail | { email: null } | null> {
  const [order] = await db.$queryRaw<
    Array<{
      email: string | null;
      customerName: string;
      phone: string;
      orderNumber: bigint;
      merchandiseSubtotalFils: bigint;
      discountFils: bigint;
      deliveryFeeFils: bigint;
      totalFils: bigint;
      areaName: string;
      deliveryEtaText: string;
    }>
  >(Prisma.sql`
    SELECT customer_email AS email, customer_name AS "customerName", customer_phone_e164 AS phone,
      order_number AS "orderNumber",
      merchandise_subtotal_fils AS "merchandiseSubtotalFils", discount_fils AS "discountFils",
      delivery_fee_fils AS "deliveryFeeFils", total_fils AS "totalFils", area_name AS "areaName",
      delivery_eta_text AS "deliveryEtaText"
    FROM orders WHERE id=${orderId}::uuid`);
  if (!order) return null;
  if (!order.email) return { email: null };
  const items = await orderEmailItems(db, orderId);
  const settings = await db.$queryRaw<Array<{ key: string; value: unknown }>>(Prisma.sql`
    SELECT key, value FROM settings WHERE key IN ('store', 'whatsapp')`);
  const value = (key: string) => settings.find((row) => row.key === key)?.value;
  const store = storeSettingsSchema.safeParse(value("store"));
  const whatsapp = whatsappSettingsSchema.safeParse(value("whatsapp"));
  return {
    email: order.email,
    customerName: order.customerName,
    phone: order.phone,
    orderNumber: formatOrderNumber(order.orderNumber),
    items,
    merchandiseSubtotalFils: Number(order.merchandiseSubtotalFils),
    discountFils: Number(order.discountFils),
    deliveryFeeFils: Number(order.deliveryFeeFils),
    totalFils: Number(order.totalFils),
    areaName: order.areaName,
    deliveryEtaText: order.deliveryEtaText,
    store: {
      name: store.success ? store.data.name : "Iqos Haven",
      domain: store.success ? store.data.domain : null,
      whatsappNumber: whatsapp.success ? whatsapp.data.number : null,
    },
  };
}
