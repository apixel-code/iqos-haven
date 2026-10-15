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
    : {
        inApp: true,
        newOrderEmail: { enabled: false, recipients: [] as string[] },
        lowStockEmail: false,
      };
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
  const notification = await insertNotification(tx, {
    eventId: input.eventId,
    type: NEW_ORDER_NOTIFICATION,
    title: "New order " + order.orderNumber,
    body,
    link: "/orders/" + order.orderId,
  });
  const notificationId = notification.id;
  const receipts = await writeReceipts(tx, notificationId, NEW_ORDER_PERMISSIONS);
  return { outcome: "written", notificationId, created: notification.created, receipts };
}
/** One receipt per active staff user whose role holds every permission; existing ones stay. */
function writeReceipts(tx: Tx, notificationId: string, permissions: readonly string[]) {
  return tx.$executeRaw(Prisma.sql`
    INSERT INTO notification_receipts (notification_id, user_id)
    SELECT ${notificationId}::uuid, s.id FROM staff_users s
    WHERE s.active AND (
      SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=s.role_id AND p.key = ANY(${[...permissions]}::text[])
    ) = ${permissions.length}
    ON CONFLICT (notification_id, user_id) DO NOTHING`);
}
/** Inserts a notification once per (event, type) and returns its ID either way. */
async function insertNotification(
  tx: Tx,
  input: { eventId: string; type: string; title: string; body: string; link: string },
) {
  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO notifications (source_event_id, type, title, body, link)
    VALUES (${input.eventId}::uuid, ${input.type}, ${input.title.slice(0, 150)},
      ${input.body.slice(0, 500)}, ${input.link})
    ON CONFLICT (source_event_id, type) DO NOTHING RETURNING id`);
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [existing] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM notifications
    WHERE source_event_id=${input.eventId}::uuid AND type=${input.type}`);
  return { id: existing!.id, created: false };
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

// --- Low stock (roadmap step 92, ADR 0060) ---
/**
 * A variant crossed into low stock (`inventory.low`, ADR 0023). Whether to alert is decided when
 * the effect runs, from current data: the variant must still be low, active and on a published
 * product. A variant alerts each channel at most once per quiet window, so stock bouncing
 * around its alert level does not repeat the alert.
 */
export const LOW_STOCK_NOTIFICATION = "inventory.low";
export const LOW_STOCK_QUIET_HOURS = 24;
const LOW_STOCK_PERMISSIONS = ["notifications.read_own", "inventory.read"] as const;

export interface LowStockSummary {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  stock: number;
  threshold: number;
}
type LowStockState =
  | { state: "missing" }
  | { state: "not_low" | "not_on_sale" }
  | { state: "low"; summary: LowStockSummary };
async function lowStockState(db: Database | Tx, variantId: string): Promise<LowStockState> {
  const [row] = await db.$queryRaw<
    Array<{
      productId: string;
      productName: string;
      sku: string;
      stock: number;
      threshold: number;
      onSale: boolean;
    }>
  >(Prisma.sql`
    SELECT p.id AS "productId", p.name AS "productName", v.sku, v.stock_on_hand AS stock,
      v.low_stock_threshold AS threshold,
      (v.active AND p.status='published' AND p.deleted_at IS NULL) AS "onSale"
    FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=${variantId}::uuid`);
  if (!row) return { state: "missing" };
  if (!row.onSale) return { state: "not_on_sale" };
  if (row.stock > row.threshold) return { state: "not_low" };
  const { productId, productName, sku, stock, threshold } = row;
  return { state: "low", summary: { variantId, productId, productName, sku, stock, threshold } };
}
/**
 * Claims this channel's alert for the variant: true when this event may alert (first alert, the
 * quiet window has passed, or this same event claimed it before), false inside the window. The
 * upsert locks the variant's row, so two crossings handled at once cannot both alert.
 */
async function claimLowStockAlert(
  db: Database | Tx,
  input: { variantId: string; channel: "inbox" | "email"; eventId: string },
): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ claimed: boolean }>>(Prisma.sql`
    INSERT INTO low_stock_alerts AS a (variant_id, channel, source_event_id)
    VALUES (${input.variantId}::uuid, ${input.channel}, ${input.eventId}::uuid)
    ON CONFLICT (variant_id, channel) DO UPDATE
      SET source_event_id=EXCLUDED.source_event_id, alerted_at=EXCLUDED.alerted_at
      WHERE a.source_event_id=EXCLUDED.source_event_id
        OR a.alerted_at <= statement_timestamp() - make_interval(hours => ${LOW_STOCK_QUIET_HOURS}::int)
    RETURNING true AS claimed`);
  return row?.claimed ?? false;
}
const stockLevel = (summary: LowStockSummary) =>
  summary.stock === 0 ? "Out of stock" : `${summary.stock} left`;

export type LowStockNotificationResult =
  | { outcome: "variant_missing" | "disabled" | "not_low" | "not_on_sale" | "quiet" }
  | { outcome: "written"; notificationId: string; created: boolean; receipts: number };
/**
 * Writes the inbox notification for a low-stock crossing and one receipt per active staff user
 * who holds `inventory.read`. Run inside the transaction that completes the effect; a
 * redelivered event keeps the first content and existing receipts.
 */
export async function writeLowStockNotification(
  tx: Tx,
  input: { eventId: string; variantId: string },
): Promise<LowStockNotificationResult> {
  const current = await lowStockState(tx, input.variantId);
  if (current.state === "missing") return { outcome: "variant_missing" };
  if (current.state !== "low") return { outcome: current.state };
  if (!(await notificationSettings(tx)).inApp) return { outcome: "disabled" };
  const { summary } = current;
  if (!(await claimLowStockAlert(tx, { ...input, channel: "inbox" }))) return { outcome: "quiet" };
  const notification = await insertNotification(tx, {
    eventId: input.eventId,
    type: LOW_STOCK_NOTIFICATION,
    title: "Low stock: " + summary.productName,
    body: `${summary.sku} · ${stockLevel(summary)} (alert level ${summary.threshold})`,
    link: "/inventory/" + summary.variantId,
  });
  const receipts = await writeReceipts(tx, notification.id, LOW_STOCK_PERMISSIONS);
  return {
    outcome: "written",
    notificationId: notification.id,
    created: notification.created,
    receipts,
  };
}
export type LowStockEmailResult =
  | { outcome: "variant_missing" }
  | { outcome: "skipped"; reason: "off" | "not_low" | "not_on_sale" | "quiet" }
  | { outcome: "send"; summary: LowStockSummary; recipients: string[] };
/**
 * Whether to email a low-stock crossing and to whom: the Settings recipients, only while the
 * low-stock email is switched on. The quiet-window claim commits on its own, before sending; a
 * retry of the same event keeps its claim.
 */
export async function loadLowStockEmail(
  db: Database,
  input: { eventId: string; variantId: string },
): Promise<LowStockEmailResult> {
  const current = await lowStockState(db, input.variantId);
  if (current.state === "missing") return { outcome: "variant_missing" };
  if (current.state !== "low") return { outcome: "skipped", reason: current.state };
  const settings = await notificationSettings(db);
  if (!settings.lowStockEmail || !settings.newOrderEmail.recipients.length)
    return { outcome: "skipped", reason: "off" };
  if (!(await claimLowStockAlert(db, { ...input, channel: "email" })))
    return { outcome: "skipped", reason: "quiet" };
  return {
    outcome: "send",
    summary: current.summary,
    recipients: [...settings.newOrderEmail.recipients],
  };
}

// --- Reviews (roadmap step 94, ADR 0062) ---
/**
 * A shopper submitted a review (`review.submitted`). The inbox says which product and the
 * rating; never the author's name or words, which moderators read in the review itself.
 * Written whatever the review's status is by then: the notification records the submission.
 */
export const REVIEW_NOTIFICATION = "review.submitted";
const REVIEW_PERMISSIONS = ["notifications.read_own", "reviews.moderate"] as const;

export type ReviewNotificationResult =
  | { outcome: "review_missing" | "disabled" }
  | { outcome: "written"; notificationId: string; created: boolean; receipts: number };
export async function writeReviewNotification(
  tx: Tx,
  input: { eventId: string; reviewId: string },
): Promise<ReviewNotificationResult> {
  const [review] = await tx.$queryRaw<Array<{ productName: string; rating: number }>>(Prisma.sql`
    SELECT p.name AS "productName", r.rating::int AS rating
    FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.id=${input.reviewId}::uuid`);
  if (!review) return { outcome: "review_missing" };
  if (!(await notificationSettings(tx)).inApp) return { outcome: "disabled" };
  const notification = await insertNotification(tx, {
    eventId: input.eventId,
    type: REVIEW_NOTIFICATION,
    title: "New review: " + review.productName,
    body: `${review.rating} of 5 stars · waiting for moderation`,
    link: "/reviews",
  });
  const receipts = await writeReceipts(tx, notification.id, REVIEW_PERMISSIONS);
  return {
    outcome: "written",
    notificationId: notification.id,
    created: notification.created,
    receipts,
  };
}

// --- Inbox (roadmap step 91, ADR 0059) ---
/**
 * What a user must hold now to see a notification type. A receipt is a snapshot of who was
 * eligible when the notification was written; someone who lost the right since does not see it.
 * A type missing here is shown to every holder of `notifications.read_own`.
 */
export const NOTIFICATION_TYPE_PERMISSIONS: Readonly<Record<string, string>> = {
  [NEW_ORDER_NOTIFICATION]: "orders.read",
  [LOW_STOCK_NOTIFICATION]: "inventory.read",
  [REVIEW_NOTIFICATION]: "reviews.moderate",
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
