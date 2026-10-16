import {
  daysBetween,
  dubaiDate,
  dubaiDayRange,
  METRIC_DEFINITION_VERSION,
  MetricRangeError,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { financialTotals } from "./financial-metrics";
import { BROWSING_EVENT_RETENTION_DAYS } from "./browsing-events";
import { withTransaction } from "./transaction";

/**
 * Daily rollups (roadmap step 106, ADR 0072). `rollupDay` recomputes one Dubai day of all four
 * daily tables from the authoritative rows and replaces that day's rows whole, so running it
 * again (a retry, a redelivered event, a scheduled pass) gives the same rows and never adds.
 * A transaction-scoped lock per day makes concurrent recomputes of one day take turns.
 */
export const ROLLUP_PARTS = ["sales", "products", "search", "wishlist"] as const;
export type RollupPart = (typeof ROLLUP_PARTS)[number];

/**
 * Recomputes one Dubai day in its own short transaction. Read Committed on purpose: each query
 * after the day lock sees the latest committed rows (a repeatable-read snapshot would be taken
 * before the lock wait and then conflict). A commit landing between two of its queries is
 * repaired by that commit's own event, which recomputes the day again.
 */
export function rollupDay(
  db: Database,
  day: string,
  parts: readonly RollupPart[] = ROLLUP_PARTS,
): Promise<void> {
  return withTransaction(db, (tx) => rollupDayIn(tx, day, parts));
}

/**
 * Controlled historical backfill (step 107, ADR 0073): recomputes Dubai days `from`..`to`
 * (≤366, none after today) oldest first, one short transaction per day, so a long run never
 * holds locks across days and can be stopped and started again. Days past the raw-event
 * retention keep their search and saved-list rows (see `rollupDayIn`).
 */
export async function backfillRollups(
  db: Database,
  from: string,
  to: string,
  options: {
    parts?: readonly RollupPart[];
    onDay?: (day: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ days: number }> {
  const days = daysBetween(from, to);
  if (to > dubaiDate(new Date())) throw new MetricRangeError("The range ends after today");
  let done = 0;
  for (const day of days) {
    if (options.signal?.aborted) break;
    await rollupDay(db, day, options.parts ?? ROLLUP_PARTS);
    done++;
    options.onDay?.(day);
  }
  return { days: done };
}

/** The same inside a transaction the caller owns (the analytics effect's). */
export async function rollupDayIn(
  tx: Tx,
  day: string,
  parts: readonly RollupPart[] = ROLLUP_PARTS,
): Promise<void> {
  const { start, end } = dubaiDayRange(day, day);
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('ih.rollup:' || ${day}, 0))`,
  );
  if (parts.includes("sales")) await rollupSales(tx, day, start, end);
  if (parts.includes("products")) await rollupProducts(tx, day, start, end);
  // Raw events are deleted after the retention window: recomputing such a day from them would
  // empty its search and saved-list rows, so those totals are kept as they are.
  const [{ expired }] = (await tx.$queryRaw<Array<{ expired: boolean }>>(Prisma.sql`
    SELECT ${start}::timestamptz < statement_timestamp()
      - make_interval(days => ${BROWSING_EVENT_RETENTION_DAYS - 1}::int) AS expired`)) as [
    { expired: boolean },
  ];
  if (!expired && parts.includes("search")) await rollupSearch(tx, day, start, end);
  if (!expired && parts.includes("wishlist")) await rollupWishlist(tx, day, start, end);
}

async function rollupSales(tx: Tx, day: string, start: Date, end: Date) {
  const { booked, delivered, collected } = await financialTotals(tx, start, end);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO sales_daily (day, placed_orders, cancelled_orders, booked_orders,
      booked_net_fils, booked_delivery_fils, booked_total_fils, cancelled_total_fils,
      delivered_orders, delivered_net_fils, delivered_delivery_fils, delivered_total_fils,
      collected_orders, collected_fils, definition_version)
    VALUES (${day}::date, ${booked.active + booked.cancelled}, ${booked.cancelled},
      ${booked.active}, ${booked.activeNet}, ${booked.activeDelivery}, ${booked.activeTotal},
      ${booked.cancelledTotal}, ${delivered.orders}, ${delivered.net}, ${delivered.delivery},
      ${delivered.total}, ${collected.orders}, ${collected.amount}, ${METRIC_DEFINITION_VERSION})
    ON CONFLICT (day) DO UPDATE SET
      placed_orders=EXCLUDED.placed_orders, cancelled_orders=EXCLUDED.cancelled_orders,
      booked_orders=EXCLUDED.booked_orders, booked_net_fils=EXCLUDED.booked_net_fils,
      booked_delivery_fils=EXCLUDED.booked_delivery_fils,
      booked_total_fils=EXCLUDED.booked_total_fils,
      cancelled_total_fils=EXCLUDED.cancelled_total_fils,
      delivered_orders=EXCLUDED.delivered_orders, delivered_net_fils=EXCLUDED.delivered_net_fils,
      delivered_delivery_fils=EXCLUDED.delivered_delivery_fils,
      delivered_total_fils=EXCLUDED.delivered_total_fils,
      collected_orders=EXCLUDED.collected_orders, collected_fils=EXCLUDED.collected_fils,
      definition_version=EXCLUDED.definition_version, computed_at=statement_timestamp()`);
}

/**
 * Ordered units and net (items after the order's discount) of orders placed that day and not
 * cancelled; delivered units, net and discount of orders delivered that day. The brand is the
 * name snapshotted on the order item.
 */
async function rollupProducts(tx: Tx, day: string, start: Date, end: Date) {
  await tx.$executeRaw(Prisma.sql`DELETE FROM product_sales_daily WHERE day=${day}::date`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO product_sales_daily (day, product_id, brand_name, ordered_units,
      ordered_net_fils, delivered_units, delivered_net_fils, delivered_discount_fils)
    SELECT ${day}::date, x.product_id, x.brand_name,
      sum(x.ordered_units)::int, sum(x.ordered_net)::bigint,
      sum(x.delivered_units)::int, sum(x.delivered_net)::bigint, sum(x.delivered_discount)::bigint
    FROM (
      SELECT i.product_id, i.brand_name, i.quantity AS ordered_units, i.total_fils AS ordered_net,
        0 AS delivered_units, 0::bigint AS delivered_net, 0::bigint AS delivered_discount
      FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.status <> 'cancelled' AND o.created_at >= ${start}::timestamptz
        AND o.created_at < ${end}::timestamptz
      UNION ALL
      SELECT i.product_id, i.brand_name, 0, 0::bigint, i.quantity, i.total_fils, i.discount_fils
      FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.status = 'delivered' AND o.delivered_at >= ${start}::timestamptz
        AND o.delivered_at < ${end}::timestamptz
    ) x
    GROUP BY x.product_id, x.brand_name`);
}

async function rollupSearch(tx: Tx, day: string, start: Date, end: Date) {
  await tx.$executeRaw(Prisma.sql`DELETE FROM search_daily WHERE day=${day}::date`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO search_daily (day, term, searches, zero_results, result_total)
    SELECT ${day}::date, coalesce(e.payload->>'term', ''), count(*)::int,
      count(*) FILTER (WHERE (e.payload->>'resultCount')::int = 0)::int,
      coalesce(sum((e.payload->>'resultCount')::bigint), 0)::bigint
    FROM events e
    WHERE e.type='search' AND e.received_at >= ${start}::timestamptz
      AND e.received_at < ${end}::timestamptz
    GROUP BY 2`);
}

async function rollupWishlist(tx: Tx, day: string, start: Date, end: Date) {
  await tx.$executeRaw(Prisma.sql`DELETE FROM wishlist_daily WHERE day=${day}::date`);
  // Products removed from the catalogue since are skipped: events keep only an ID.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO wishlist_daily (day, product_id, adds, removes)
    SELECT ${day}::date, (e.payload->>'productId')::uuid,
      count(*) FILTER (WHERE e.type='wishlist_add')::int,
      count(*) FILTER (WHERE e.type='wishlist_remove')::int
    FROM events e
    WHERE e.type IN ('wishlist_add', 'wishlist_remove')
      AND e.received_at >= ${start}::timestamptz AND e.received_at < ${end}::timestamptz
      AND EXISTS (SELECT 1 FROM products p WHERE p.id=(e.payload->>'productId')::uuid)
    GROUP BY 2`);
}

/**
 * Read before the day locks are taken: a day the order moves to afterwards gets its own event
 * and recompute. Days come back sorted, so effects lock days in one order and never deadlock.
 *
 * The Dubai days an order's figures fall on: placed, delivered, and every collection record
 * (a correction can move cash to another day, and the old day must drop it).
 */
export async function orderRollupDays(tx: Database | Tx, orderId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ day: string }>>(Prisma.sql`
    SELECT DISTINCT to_char(d AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD') AS day FROM (
      SELECT created_at AS d FROM orders WHERE id=${orderId}::uuid
      UNION ALL SELECT delivered_at FROM orders WHERE id=${orderId}::uuid AND delivered_at IS NOT NULL
      UNION ALL SELECT collected_at FROM order_collection_records WHERE order_id=${orderId}::uuid
    ) x ORDER BY 1`);
  return rows.map((row) => row.day);
}
