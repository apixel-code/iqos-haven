import { adminDashboardSchema, type AdminDashboard } from "@ih/contracts";
import {
  addDays,
  averageFils,
  DELAYED_AFTER_MINUTES,
  dubaiDate,
  dubaiDayRange,
  formatOrderNumber,
  TAX_NOTE,
} from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { readSalesDays, type SalesDay } from "./daily-summary";

export class DashboardForbiddenError extends Error {}

/** An open order waiting too long (BI-14 defaults); the orders list filters by the same rule. */
export const DELAYED_ORDER = Prisma.sql`(
  (o.status='pending'
    AND o.created_at < now() - make_interval(mins => ${DELAYED_AFTER_MINUTES.pending}::int))
  OR (o.status IN ('confirmed','processing')
    AND o.created_at < now() - make_interval(mins => ${DELAYED_AFTER_MINUTES.inProgress}::int)))`;

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: Date;
  delayed: boolean;
  totalFils: bigint;
  customerName: string;
}
const ORDER_COLUMNS = Prisma.sql`o.id, o.order_number::text AS "orderNumber", o.status,
  o.created_at AS "createdAt", ${DELAYED_ORDER} AS delayed, o.total_fils AS "totalFils",
  o.customer_name AS "customerName"`;

/**
 * The operational home dashboard for one staff member (roadmap step 108, ADR 0074). One
 * repeatable-read snapshot, so the counts agree with each other and with the lists. Each section
 * is read only when the caller holds its permission inside that snapshot (a right revoked
 * meanwhile is seen); otherwise it is `null` and never queried. Customer names need
 * `customers.read`; product sales amounts and the day figures need `dashboard.financial_read`.
 */
export async function readAdminDashboard(db: Database, actorId: string): Promise<AdminDashboard> {
  return db.$transaction(
    async (tx) => {
      const [actor] = await tx.$queryRaw<Array<{ permissions: string[]; now: Date }>>(Prisma.sql`
        SELECT coalesce(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions,
          now() AS now
        FROM staff_users u
        LEFT JOIN role_permissions rp ON rp.role_id=u.role_id
        LEFT JOIN permissions p ON p.id=rp.permission_id
        WHERE u.id=${actorId}::uuid AND u.active GROUP BY u.id`);
      if (!actor) throw new DashboardForbiddenError();
      const held = new Set(actor.permissions);
      const now = actor.now;
      const today = dubaiDate(now);
      const financial = held.has("dashboard.financial_read");
      return adminDashboardSchema.parse({
        generatedAt: now.toISOString(),
        timezone: "Asia/Dubai",
        orders: held.has("orders.read")
          ? await orderSection(tx, now, today, held.has("customers.read"))
          : null,
        stock: held.has("inventory.read") ? await stockSection(tx) : null,
        reviews: held.has("reviews.moderate")
          ? {
              pending: (
                await tx.$queryRaw<Array<{ n: number }>>(
                  Prisma.sql`SELECT count(*)::int AS n FROM reviews WHERE status='pending'`,
                )
              )[0]!.n,
            }
          : null,
        topProducts: held.has("orders.read") ? await topProducts(tx, today, financial) : null,
        sales: financial ? await salesSection(tx, today) : null,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function orderSection(tx: Tx, now: Date, today: string, names: boolean) {
  const { start } = dubaiDayRange(today, today);
  const yesterdayStart = new Date(start.getTime() - 86_400_000);
  const sameTimeYesterday = new Date(now.getTime() - 86_400_000);
  const [counts] = await tx.$queryRaw<
    Array<{
      pending: number;
      confirmed: number;
      processing: number;
      outForDelivery: number;
      delayed: number;
      placedToday: number;
      placedYesterdaySoFar: number;
    }>
  >(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE o.status='pending')::int AS pending,
      count(*) FILTER (WHERE o.status='confirmed')::int AS confirmed,
      count(*) FILTER (WHERE o.status='processing')::int AS processing,
      count(*) FILTER (WHERE o.status='out_for_delivery')::int AS "outForDelivery",
      count(*) FILTER (WHERE ${DELAYED_ORDER})::int AS delayed,
      (SELECT count(*)::int FROM orders t WHERE t.created_at >= ${start}::timestamptz)
        AS "placedToday",
      (SELECT count(*)::int FROM orders y WHERE y.created_at >= ${yesterdayStart}::timestamptz
        AND y.created_at < ${sameTimeYesterday}::timestamptz) AS "placedYesterdaySoFar"
    FROM orders o
    WHERE o.status IN ('pending','confirmed','processing','out_for_delivery')`);
  const attention = await tx.$queryRaw<OrderRow[]>(Prisma.sql`
    SELECT ${ORDER_COLUMNS} FROM orders o
    WHERE o.status='pending' OR ${DELAYED_ORDER}
    ORDER BY o.created_at, o.id LIMIT 5`);
  const recent = await tx.$queryRaw<OrderRow[]>(Prisma.sql`
    SELECT ${ORDER_COLUMNS} FROM orders o ORDER BY o.created_at DESC, o.id DESC LIMIT 7`);
  const line = (row: OrderRow) => ({
    id: row.id,
    orderNumber: formatOrderNumber(row.orderNumber),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    delayed: row.delayed,
    totalFils: Number(row.totalFils),
    customerName: names ? row.customerName : null,
  });
  const { delayed, placedToday, placedYesterdaySoFar, ...open } = counts!;
  return {
    open,
    delayed,
    delayedAfterMinutes: DELAYED_AFTER_MINUTES,
    placedToday,
    placedYesterdaySoFar,
    attention: attention.map(line),
    recent: recent.map(line),
  };
}

const ON_SALE_LOW = Prisma.sql`v.active AND p.status='published' AND p.deleted_at IS NULL
  AND v.stock_on_hand <= v.low_stock_threshold`;
async function stockSection(tx: Tx) {
  const [counts] = await tx.$queryRaw<Array<{ low: number; out: number }>>(Prisma.sql`
    SELECT count(*) FILTER (WHERE v.stock_on_hand > 0)::int AS low,
      count(*) FILTER (WHERE v.stock_on_hand <= 0)::int AS out
    FROM variants v JOIN products p ON p.id=v.product_id WHERE ${ON_SALE_LOW}`);
  const items = await tx.$queryRaw<
    Array<{
      variantId: string;
      productId: string;
      productName: string;
      sku: string;
      stock: number;
      threshold: number;
    }>
  >(Prisma.sql`
    SELECT v.id AS "variantId", p.id AS "productId", p.name AS "productName", v.sku,
      v.stock_on_hand AS stock, v.low_stock_threshold AS threshold
    FROM variants v JOIN products p ON p.id=v.product_id WHERE ${ON_SALE_LOW}
    ORDER BY v.stock_on_hand, p.name, v.sku LIMIT 5`);
  return { ...counts!, items };
}

/** From the daily product table: up to ten minutes behind the live orders (ADR 0073). */
async function topProducts(tx: Tx, today: string, financial: boolean) {
  const from = addDays(today, -6);
  const rows = await tx.$queryRaw<
    Array<{ productId: string; name: string; units: number; net: bigint }>
  >(Prisma.sql`
    SELECT p.id AS "productId", p.name, sum(d.ordered_units)::int AS units,
      sum(d.ordered_net_fils)::bigint AS net
    FROM product_sales_daily d JOIN products p ON p.id=d.product_id
    WHERE d.day BETWEEN ${from}::date AND ${today}::date AND p.deleted_at IS NULL
    GROUP BY p.id, p.name HAVING sum(d.ordered_units) > 0
    ORDER BY units DESC, p.name, p.id LIMIT 5`);
  return {
    from,
    to: today,
    items: rows.map((row) => ({
      productId: row.productId,
      name: row.name,
      units: row.units,
      netFils: financial ? Number(row.net) : null,
    })),
  };
}

async function salesSection(tx: Tx, today: string) {
  const yesterday = addDays(today, -1);
  const { days } = await readSalesDays(tx, yesterday, today);
  const day = (key: string) => {
    const row: SalesDay | undefined = days.find((item) => item.day === key);
    if (!row) return null;
    return {
      day: key,
      orders: row.bookedOrders,
      totalFils: row.bookedTotalFils,
      aovFils: averageFils(BigInt(row.bookedTotalFils), row.bookedOrders),
      cancelledOrders: row.cancelledOrders,
      computedAt: row.computedAt.toISOString(),
    };
  };
  return { currency: "AED", taxNote: TAX_NOTE, today: day(today), yesterday: day(yesterday) };
}
