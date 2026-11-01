import { storeSettingsSchema, whatsappSettingsSchema } from "@ih/contracts";
import { formatOrderNumber } from "@ih/domain";
import { Prisma, type Database } from "./client";

/** What the shopper's order confirmation says (ADR 0102), loaded from the order's snapshots. */
export interface CustomerOrderEmail {
  email: string;
  customerName: string;
  orderNumber: string;
  items: Array<{ name: string; options: string; quantity: number; totalFils: number }>;
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
      orderNumber: bigint;
      merchandiseSubtotalFils: bigint;
      discountFils: bigint;
      deliveryFeeFils: bigint;
      totalFils: bigint;
      areaName: string;
      deliveryEtaText: string;
    }>
  >(Prisma.sql`
    SELECT customer_email AS email, customer_name AS "customerName", order_number AS "orderNumber",
      merchandise_subtotal_fils AS "merchandiseSubtotalFils", discount_fils AS "discountFils",
      delivery_fee_fils AS "deliveryFeeFils", total_fils AS "totalFils", area_name AS "areaName",
      delivery_eta_text AS "deliveryEtaText"
    FROM orders WHERE id=${orderId}::uuid`);
  if (!order) return null;
  if (!order.email) return { email: null };
  const items = await db.$queryRaw<
    Array<{ name: string; attributes: unknown; quantity: number; totalFils: bigint }>
  >(Prisma.sql`
    SELECT product_name AS name, attributes, quantity, total_fils AS "totalFils"
    FROM order_items WHERE order_id=${orderId}::uuid ORDER BY product_name, sku`);
  const settings = await db.$queryRaw<Array<{ key: string; value: unknown }>>(Prisma.sql`
    SELECT key, value FROM settings WHERE key IN ('store', 'whatsapp')`);
  const value = (key: string) => settings.find((row) => row.key === key)?.value;
  const store = storeSettingsSchema.safeParse(value("store"));
  const whatsapp = whatsappSettingsSchema.safeParse(value("whatsapp"));
  return {
    email: order.email,
    customerName: order.customerName,
    orderNumber: formatOrderNumber(order.orderNumber),
    items: items.map((item) => ({
      name: item.name,
      options: Object.values(
        item.attributes && typeof item.attributes === "object" ? item.attributes : {},
      )
        .filter((part): part is string => typeof part === "string")
        .join(" · "),
      quantity: item.quantity,
      totalFils: Number(item.totalFils),
    })),
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
