import { notificationSettingsSchema } from "@ih/contracts";
import { fils, formatAed, formatOrderNumber } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";

/**
 * Staff notifications for a new order (roadmap step 78, ADR 0047). Both readers work from the
 * order ID in the event and load what they need themselves. Neither returns nor stores who
 * ordered or where it goes: an order number, a unit count, a total and the area only.
 */
export const NEW_ORDER_NOTIFICATION = "order.new";
/** Both are needed to be told about an order: an inbox, and the right to open the order. */
const NEW_ORDER_PERMISSIONS = ["notifications.read_own", "orders.read"] as const;

export interface NewOrderSummary {
  orderId: string;
  orderNumber: string;
  totalFils: number;
  units: number;
  areaName: string;
  placedAt: Date;
}
async function newOrderSummary(db: Database | Tx, orderId: string) {
  const [row] = await db.$queryRaw<
    Array<{ orderNumber: string; totalFils: bigint; units: number; areaName: string; at: Date }>
  >(Prisma.sql`
    SELECT o.order_number::text AS "orderNumber", o.total_fils::bigint AS "totalFils",
      (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_items i WHERE i.order_id=o.id) AS units,
      o.area_name AS "areaName", o.created_at AS at
    FROM orders o WHERE o.id=${orderId}::uuid`);
  if (!row) return null;
  return {
    orderId,
    orderNumber: formatOrderNumber(row.orderNumber),
    totalFils: Number(row.totalFils),
    units: row.units,
    areaName: row.areaName,
    placedAt: row.at,
  } satisfies NewOrderSummary;
}
/** The Owner's notification choices; nothing configured means the inbox is on and email is off. */
async function notificationSettings(db: Database | Tx) {
  const [row] = await db.$queryRaw<Array<{ value: unknown }>>(
    Prisma.sql`SELECT value FROM settings WHERE key='notifications'`,
  );
  const parsed = notificationSettingsSchema.safeParse(row?.value);
  return parsed.success
    ? parsed.data
    : { inApp: true, newOrderEmail: { enabled: false, recipients: [] as string[] } };
}
export type NewOrderNotificationResult =
  | { outcome: "order_missing" }
  | { outcome: "disabled" }
  | { outcome: "written"; notificationId: string; created: boolean; receipts: number };
/**
 * Writes the inbox notification for a new order and one receipt per eligible staff user.
 * Run inside the transaction that completes the effect. Safe to run again for the same event:
 * the content is kept as first written and existing receipts (and their read state) are left
 * alone. Recipients are the active staff who hold both permissions now.
 */
export async function writeNewOrderNotification(
  tx: Tx,
  input: { eventId: string; orderId: string },
): Promise<NewOrderNotificationResult> {
  const order = await newOrderSummary(tx, input.orderId);
  if (!order) return { outcome: "order_missing" };
  if (!(await notificationSettings(tx)).inApp) return { outcome: "disabled" };
  const body = `${order.units} ${order.units === 1 ? "item" : "items"} · ${formatAed(fils(order.totalFils))} · ${order.areaName}`;
  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO notifications (source_event_id, type, title, body, link)
    VALUES (${input.eventId}::uuid, ${NEW_ORDER_NOTIFICATION},
      ${"New order " + order.orderNumber}, ${body.slice(0, 500)}, ${"/orders/" + order.orderId})
    ON CONFLICT (source_event_id, type) DO NOTHING RETURNING id`);
  const notificationId =
    inserted[0]?.id ??
    (
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM notifications
        WHERE source_event_id=${input.eventId}::uuid AND type=${NEW_ORDER_NOTIFICATION}`)
    )[0]!.id;
  const receipts = await tx.$executeRaw(Prisma.sql`
    INSERT INTO notification_receipts (notification_id, user_id)
    SELECT ${notificationId}::uuid, s.id FROM staff_users s
    WHERE s.active AND (
      SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=s.role_id AND p.key = ANY(${[...NEW_ORDER_PERMISSIONS]}::text[])
    ) = ${NEW_ORDER_PERMISSIONS.length}
    ON CONFLICT (notification_id, user_id) DO NOTHING`);
  return { outcome: "written", notificationId, created: Boolean(inserted[0]), receipts };
}
/**
 * What the new-order email says and who gets it: the addresses the Owner entered under
 * Settings → Notifications, and none unless that email is switched on.
 */
export async function loadNewOrderEmail(
  db: Database,
  orderId: string,
): Promise<{ order: NewOrderSummary; recipients: string[] } | null> {
  const order = await newOrderSummary(db, orderId);
  if (!order) return null;
  const { newOrderEmail } = await notificationSettings(db);
  return { order, recipients: newOrderEmail.enabled ? [...newOrderEmail.recipients] : [] };
}
