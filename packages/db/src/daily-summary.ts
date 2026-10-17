import { defineEvent } from "@ih/contracts";
import { daysBetween } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { rollupDay } from "./daily-rollups";
import { notificationSettings } from "./notifications";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/** One computed `sales_daily` row; amounts in integer fils (AED). */
export interface SalesDay {
  day: string;
  placedOrders: number;
  cancelledOrders: number;
  bookedOrders: number;
  bookedNetFils: number;
  bookedDeliveryFils: number;
  bookedTotalFils: number;
  cancelledTotalFils: number;
  deliveredOrders: number;
  deliveredNetFils: number;
  deliveredDeliveryFils: number;
  deliveredTotalFils: number;
  collectedOrders: number;
  collectedFils: number;
  definitionVersion: number;
  /** Freshness: when this day was last recomputed. */
  computedAt: Date;
}

/**
 * The daily sales rows for Dubai days `from`..`to` (≤366) with their freshness (step 107,
 * ADR 0073). A day without a row is listed in `missing`: not computed, which is not zero.
 */
export async function readSalesDays(
  db: Database | Tx,
  from: string,
  to: string,
): Promise<{ days: SalesDay[]; missing: string[] }> {
  const wanted = daysBetween(from, to); // throws MetricRangeError for a bad range
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, placed_orders, cancelled_orders, booked_orders,
      booked_net_fils, booked_delivery_fils, booked_total_fils, cancelled_total_fils,
      delivered_orders, delivered_net_fils, delivered_delivery_fils, delivered_total_fils,
      collected_orders, collected_fils, definition_version, computed_at
    FROM sales_daily WHERE day BETWEEN ${from}::date AND ${to}::date ORDER BY day`);
  const days = rows.map((row): SalesDay => ({
    day: row.day as string,
    placedOrders: Number(row.placed_orders),
    cancelledOrders: Number(row.cancelled_orders),
    bookedOrders: Number(row.booked_orders),
    bookedNetFils: Number(row.booked_net_fils),
    bookedDeliveryFils: Number(row.booked_delivery_fils),
    bookedTotalFils: Number(row.booked_total_fils),
    cancelledTotalFils: Number(row.cancelled_total_fils),
    deliveredOrders: Number(row.delivered_orders),
    deliveredNetFils: Number(row.delivered_net_fils),
    deliveredDeliveryFils: Number(row.delivered_delivery_fils),
    deliveredTotalFils: Number(row.delivered_total_fils),
    collectedOrders: Number(row.collected_orders),
    collectedFils: Number(row.collected_fils),
    definitionVersion: Number(row.definition_version),
    computedAt: row.computed_at as Date,
  }));
  const present = new Set(days.map((day) => day.day));
  return { days, missing: wanted.filter((day) => !present.has(day)) };
}

/**
 * Writes the `report.daily_summary` event for a Dubai day once (step 107, ADR 0073). A per-day
 * lock makes concurrent writers take turns and the second finds the first's event; the unique
 * index `outbox_events_one_daily_summary` is the backstop. `created: false` means the day's
 * summary was already handed to the outbox, so a retried or reclaimed slot sends nothing more.
 */
export function emitDailySummary(
  db: Database,
  day: string,
): Promise<{ eventId: string; created: boolean }> {
  daysBetween(day, day);
  return withTransaction(db, async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('ih.daily_summary:' || ${day}, 0))`,
    );
    const [existing] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM outbox_events
      WHERE event_type='report.daily_summary' AND aggregate_id=${day}`);
    if (existing) return { eventId: existing.id, created: false };
    const eventId = await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("report.daily_summary", day, { day }),
    );
    return { eventId, created: true };
  });
}

/** Holding this right is what lets someone receive revenue figures by email. */
export const DAILY_SUMMARY_PERMISSION = "dashboard.financial_read";

export interface DailySummaryContent {
  sales: SalesDay;
  /** Up to five products by units ordered that day (orders not cancelled), current names. */
  topProducts: Array<{ name: string; units: number }>;
}
export type DailySummaryEmailResult =
  | { outcome: "skipped"; reason: "off" | "no_permitted_recipients" }
  | { outcome: "send"; content: DailySummaryContent; recipients: string[] };

/**
 * Whether to send a day's summary and to whom (step 107, ADR 0073). Off unless the Owner
 * switched it on. Recipients are the Settings addresses that belong to active staff who hold
 * `dashboard.financial_read` now: an address on the list without that right, or of a
 * deactivated account, gets nothing. The day is recomputed first, so the figures are fresh.
 */
export async function loadDailySummaryEmail(
  db: Database,
  day: string,
): Promise<DailySummaryEmailResult> {
  const settings = await notificationSettings(db);
  const listed = settings.newOrderEmail.recipients.map((email) => email.toLowerCase());
  if (!settings.dailySummaryEmail || !listed.length) return { outcome: "skipped", reason: "off" };
  const allowed = await db.$queryRaw<Array<{ email: string }>>(Prisma.sql`
    SELECT lower(s.email) AS email FROM staff_users s
    WHERE s.active AND lower(s.email) = ANY(${listed}::text[])
      AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=s.role_id AND p.key=${DAILY_SUMMARY_PERMISSION})
    ORDER BY 1`);
  if (!allowed.length) return { outcome: "skipped", reason: "no_permitted_recipients" };
  await rollupDay(db, day, ["sales", "products"]);
  const { days } = await readSalesDays(db, day, day);
  const top = await db.$queryRaw<Array<{ name: string; units: number }>>(Prisma.sql`
    SELECT p.name, sum(d.ordered_units)::int AS units
    FROM product_sales_daily d JOIN products p ON p.id=d.product_id
    WHERE d.day=${day}::date AND d.ordered_units > 0
    GROUP BY p.id, p.name ORDER BY units DESC, p.name LIMIT 5`);
  return {
    outcome: "send",
    content: { sales: days[0]!, topProducts: top },
    recipients: allowed.map((row) => row.email),
  };
}
