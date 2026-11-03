import { orderTrackingResponseSchema, type OrderTrackingResponse } from "@ih/contracts";
import { formatOrderNumber, isTrackableOrderNumber } from "@ih/domain";
import { Prisma, type Database } from "./client";

/**
 * Order tracking by number alone (ADR 0104). Only random numbers are looked up: an order with a
 * sequential number from before ADR 0104 is answered exactly like a number that does not exist.
 * One indexed read; only the fields tracking shows leave SQL (no name, phone, email, address
 * lines, notes or internal IDs).
 */
export async function readOrderTracking(
  db: Database,
  orderNumber: number,
): Promise<OrderTrackingResponse | null> {
  if (!isTrackableOrderNumber(orderNumber)) return null;
  const [row] = await db.$queryRaw<Array<{ value: Record<string, unknown> }>>(Prisma.sql`
 SELECT jsonb_build_object(
   'placedAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'status',o.status,'merchandiseSubtotalFils',o.merchandise_subtotal_fils,
   'discountFils',o.discount_fils,'deliveryFeeFils',o.delivery_fee_fils,'totalFils',o.total_fils,
   'etaText',o.delivery_eta_text,'area',jsonb_build_object('name',o.area_name,'emirate',o.area_emirate),
   'timeline',(SELECT jsonb_agg(jsonb_build_object('status',h.to_status,
       'at',to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY h.seq)
     FROM (SELECT to_status, created_at, seq FROM order_status_history
       WHERE order_id=o.id ORDER BY seq LIMIT 20) h),
   'items',(SELECT jsonb_agg(jsonb_build_object('name',i.product_name,'attributes',i.attributes,
     'quantity',i.quantity,'unitPriceFils',i.unit_price_fils,'totalFils',i.total_fils) ORDER BY i.id)
     FROM order_items i WHERE i.order_id=o.id)) AS value
 FROM orders o WHERE o.order_number=${BigInt(orderNumber)}`);
  if (!row) return null;
  return orderTrackingResponseSchema.parse({
    ...row.value,
    orderNumber: formatOrderNumber(orderNumber),
  });
}
