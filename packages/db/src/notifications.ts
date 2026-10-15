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

// --- Inbox (roadmap step 91, ADR 0059) ---
/**
 * What a user must hold now to see a notification type. A receipt is a snapshot of who was
 * eligible when the notification was written; someone who lost the right since does not see it.
 * A type missing here is shown to every holder of `notifications.read_own`.
 */
export const NOTIFICATION_TYPE_PERMISSIONS: Readonly<Record<string, string>> = {
  [NEW_ORDER_NOTIFICATION]: "orders.read",
};
export class InboxForbiddenError extends Error {}
export class InboxNotFoundError extends Error {}

interface InboxRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
}
/** The types this user may see now, or a refusal without `notifications.read_own`. */
async function visibleTypes(db: Database | Tx, userId: string): Promise<Prisma.Sql> {
  const [row] = await db.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
    SELECT coalesce(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
    FROM staff_users u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id
    LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE u.id=${userId}::uuid AND u.active GROUP BY u.id`);
  const held = row?.permissions ?? [];
  if (!held.includes("notifications.read_own")) throw new InboxForbiddenError();
  const hidden = Object.entries(NOTIFICATION_TYPE_PERMISSIONS)
    .filter(([, permission]) => !held.includes(permission))
    .map(([type]) => type);
  return hidden.length ? Prisma.sql`NOT (n.type = ANY(${hidden}::text[]))` : Prisma.sql`true`;
}
const toInbox = (row: InboxRow) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  link: row.link,
  createdAt: row.createdAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
});
const SELECT_INBOX = Prisma.sql`
  SELECT n.id, n.type, n.title, n.body, n.link, n.created_at AS "createdAt",
    r.read_at AS "readAt"
  FROM notification_receipts r JOIN notifications n ON n.id=r.notification_id`;

/** The user's own inbox, newest first (notification IDs are time-ordered). */
export async function listInbox(
  db: Database,
  userId: string,
  query: { limit: number; after?: string | undefined; unread?: boolean },
) {
  const allowed = await visibleTypes(db, userId);
  const rows = await db.$queryRaw<InboxRow[]>(Prisma.sql`${SELECT_INBOX}
    WHERE r.user_id=${userId}::uuid AND ${allowed}
      ${query.unread ? Prisma.sql`AND r.read_at IS NULL` : Prisma.empty}
      ${query.after ? Prisma.sql`AND n.id < ${query.after}::uuid` : Prisma.empty}
    ORDER BY n.id DESC LIMIT ${query.limit + 1}`);
  const [unread] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count FROM notification_receipts r
    JOIN notifications n ON n.id=r.notification_id
    WHERE r.user_id=${userId}::uuid AND r.read_at IS NULL AND ${allowed}`);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toInbox),
    unreadCount: unread?.count ?? 0,
    nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
  };
}
/** Marks one of the user's own notifications read. Reading it again keeps the first time. */
export async function markNotificationRead(db: Database, userId: string, notificationId: string) {
  const allowed = await visibleTypes(db, userId);
  const [row] = await db.$queryRaw<Array<{ readAt: Date }>>(Prisma.sql`
    WITH target AS (
      SELECT r.notification_id, r.read_at FROM notification_receipts r
      JOIN notifications n ON n.id=r.notification_id
      WHERE r.user_id=${userId}::uuid AND r.notification_id=${notificationId}::uuid AND ${allowed}),
    marked AS (
      UPDATE notification_receipts r SET read_at=statement_timestamp()
      FROM target t
      WHERE r.notification_id=t.notification_id AND r.user_id=${userId}::uuid
        AND r.read_at IS NULL
      RETURNING r.read_at)
    SELECT coalesce((SELECT read_at FROM marked), (SELECT read_at FROM target)) AS "readAt"
    WHERE EXISTS (SELECT 1 FROM target)`);
  if (!row) throw new InboxNotFoundError();
  return { id: notificationId, readAt: row.readAt.toISOString() };
}
/** Marks the user's unread notifications up to `upTo` read; returns how many changed. */
export async function markInboxReadUpTo(db: Database, userId: string, upTo: string) {
  const allowed = await visibleTypes(db, userId);
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE notification_receipts r SET read_at=statement_timestamp()
    FROM notifications n
    WHERE n.id=r.notification_id AND r.user_id=${userId}::uuid AND r.read_at IS NULL
      AND r.notification_id <= ${upTo}::uuid AND ${allowed}`);
  return { updated };
}
/** For the event stream: the user's notifications after `afterId`, oldest first. */
export async function inboxAfter(
  db: Database,
  userId: string,
  afterId: string | null,
  limit = 50,
): Promise<Array<{ id: string; type: string }>> {
  const allowed = await visibleTypes(db, userId);
  return db.$queryRaw<Array<{ id: string; type: string }>>(Prisma.sql`
    SELECT n.id, n.type FROM notification_receipts r JOIN notifications n ON n.id=r.notification_id
    WHERE r.user_id=${userId}::uuid AND ${allowed}
      ${afterId ? Prisma.sql`AND n.id > ${afterId}::uuid` : Prisma.empty}
    ORDER BY n.id ASC LIMIT ${limit}`);
}
/** The newest notification this user can see, where a fresh stream starts. */
export async function latestInboxId(db: Database, userId: string): Promise<string | null> {
  const allowed = await visibleTypes(db, userId);
  const [row] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT n.id FROM notification_receipts r JOIN notifications n ON n.id=r.notification_id
    WHERE r.user_id=${userId}::uuid AND ${allowed} ORDER BY n.id DESC LIMIT 1`);
  return row?.id ?? null;
}
