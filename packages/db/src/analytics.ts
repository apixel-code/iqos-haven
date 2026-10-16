import {
  analyticsQuerySchema,
  analyticsSchema,
  ORDER_STATUSES_FOR_MIX,
  type Analytics,
  type AnalyticsQuery,
} from "@ih/contracts";
import {
  addDays,
  averageFils,
  dubaiDayRange,
  METRIC_DEFINITION_VERSION,
  rateBps,
  TAX_NOTE,
} from "@ih/domain";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { Prisma, type Database, type Tx } from "./client";
import { readSalesDays, type SalesDay } from "./daily-summary";
import { FinancialReadForbiddenError } from "./financial-metrics";

const n = (value: bigint | number | null | undefined) => Number(value ?? 0);

/**
 * The Owner's analytics for Dubai days `from`..`to` (roadmap step 109, ADR 0075), from the
 * daily tables in one repeatable-read snapshot. The right is checked inside the snapshot. Days
 * not computed are listed and contribute nothing; the previous period of the same length is
 * read the same way for comparison. Only the status mix is live (orders placed in the range by
 * their status now).
 */
export async function readAnalytics(
  db: Database,
  actorId: string,
  input: AnalyticsQuery,
): Promise<Analytics> {
  const query = analyticsQuerySchema.parse(input);
  // Throws MetricRangeError for an impossible or over-long range.
  const { start, end, days } = dubaiDayRange(query.from, query.to);
  const previousFrom = addDays(query.from, -days);
  const previousTo = addDays(query.from, -1);
  return db.$transaction(
    async (tx) => {
      try {
        await lockCatalogueActor(tx, actorId, ["dashboard.financial_read"], false);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new FinancialReadForbiddenError();
        throw error;
      }
      const sales = await readSalesDays(tx, query.from, query.to);
      const previous = await readSalesDays(tx, previousFrom, previousTo);
      const sum = (rows: SalesDay[], key: keyof SalesDay) =>
        rows.reduce((total, row) => total + BigInt(row[key] as number), 0n);
      const t = (key: keyof SalesDay) => sum(sales.days, key);
      const placed = Number(t("placedOrders"));
      const cancelled = Number(t("cancelledOrders"));
      const booked = Number(t("bookedOrders"));
      const delivered = Number(t("deliveredOrders"));
      const collected = Number(t("collectedOrders"));
      const prevBooked = Number(sum(previous.days, "bookedOrders"));
      const prevPlaced = Number(sum(previous.days, "placedOrders"));
      const computed = sales.days.map((row) => row.computedAt.getTime());
      return analyticsSchema.parse({
        range: { from: query.from, to: query.to, days, timezone: "Asia/Dubai" },
        currency: "AED",
        taxNote: TAX_NOTE,
        definitionVersion: METRIC_DEFINITION_VERSION,
        freshness: {
          computedDays: sales.days.length,
          missing: sales.missing,
          oldestComputedAt: computed.length ? new Date(Math.min(...computed)).toISOString() : null,
          newestComputedAt: computed.length ? new Date(Math.max(...computed)).toISOString() : null,
        },
        totals: {
          placed,
          booked: {
            orders: booked,
            merchandiseNetFils: Number(t("bookedNetFils")),
            deliveryFils: Number(t("bookedDeliveryFils")),
            totalFils: Number(t("bookedTotalFils")),
            aovFils: averageFils(t("bookedTotalFils"), booked),
          },
          cancelled: {
            orders: cancelled,
            totalFils: Number(t("cancelledTotalFils")),
            rateBps: rateBps(cancelled, placed),
          },
          delivered: {
            orders: delivered,
            merchandiseNetFils: Number(t("deliveredNetFils")),
            deliveryFils: Number(t("deliveredDeliveryFils")),
            totalFils: Number(t("deliveredTotalFils")),
            aovFils: averageFils(t("deliveredTotalFils"), delivered),
          },
          collected: {
            orders: collected,
            amountFils: Number(t("collectedFils")),
            aovFils: averageFils(t("collectedFils"), collected),
          },
        },
        previous: {
          from: previousFrom,
          to: previousTo,
          missingDays: previous.missing.length,
          bookedOrders: prevBooked,
          bookedTotalFils: Number(sum(previous.days, "bookedTotalFils")),
          aovFils: averageFils(sum(previous.days, "bookedTotalFils"), prevBooked),
          cancellationRateBps: rateBps(Number(sum(previous.days, "cancelledOrders")), prevPlaced),
        },
        days: sales.days.map((row) => ({
          day: row.day,
          placed: row.placedOrders,
          cancelled: row.cancelledOrders,
          bookedOrders: row.bookedOrders,
          bookedTotalFils: row.bookedTotalFils,
          deliveredOrders: row.deliveredOrders,
          deliveredTotalFils: row.deliveredTotalFils,
          collectedFils: row.collectedFils,
        })),
        statusMix: await statusMix(tx, start, end),
        ...(await productsAndBrands(tx, query.from, query.to)),
        search: await search(tx, query.from, query.to),
        wishlist: await wishlist(tx, query.from, query.to),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function statusMix(tx: Tx, start: Date, end: Date) {
  const rows = await tx.$queryRaw<Array<{ status: string; n: number }>>(Prisma.sql`
    SELECT status, count(*)::int AS n FROM orders
    WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
    GROUP BY status`);
  return Object.fromEntries(
    ORDER_STATUSES_FOR_MIX.map((status) => [
      status,
      rows.find((row) => row.status === status)?.n ?? 0,
    ]),
  );
}

async function productsAndBrands(tx: Tx, from: string, to: string) {
  const range = Prisma.sql`d.day BETWEEN ${from}::date AND ${to}::date`;
  const [all] = await tx.$queryRaw<Array<{ net: bigint }>>(Prisma.sql`
    SELECT coalesce(sum(d.delivered_net_fils), 0)::bigint AS net FROM product_sales_daily d
    WHERE ${range}`);
  const products = await tx.$queryRaw<
    Array<{
      productId: string;
      name: string;
      orderedUnits: number;
      orderedNet: bigint;
      deliveredUnits: number;
      deliveredNet: bigint;
    }>
  >(Prisma.sql`
    SELECT p.id AS "productId", p.name, sum(d.ordered_units)::int AS "orderedUnits",
      sum(d.ordered_net_fils)::bigint AS "orderedNet",
      sum(d.delivered_units)::int AS "deliveredUnits",
      sum(d.delivered_net_fils)::bigint AS "deliveredNet"
    FROM product_sales_daily d JOIN products p ON p.id=d.product_id
    WHERE ${range}
    GROUP BY p.id, p.name
    ORDER BY "deliveredNet" DESC, "orderedUnits" DESC, p.name, p.id LIMIT 20`);
  const brands = await tx.$queryRaw<
    Array<{ brandName: string; orderedUnits: number; deliveredUnits: number; deliveredNet: bigint }>
  >(Prisma.sql`
    SELECT d.brand_name AS "brandName", sum(d.ordered_units)::int AS "orderedUnits",
      sum(d.delivered_units)::int AS "deliveredUnits",
      sum(d.delivered_net_fils)::bigint AS "deliveredNet"
    FROM product_sales_daily d WHERE ${range}
    GROUP BY d.brand_name
    ORDER BY "deliveredNet" DESC, "orderedUnits" DESC, d.brand_name LIMIT 20`);
  const total = n(all?.net);
  return {
    products: products.map((row) => ({
      productId: row.productId,
      name: row.name,
      orderedUnits: row.orderedUnits,
      orderedNetFils: n(row.orderedNet),
      deliveredUnits: row.deliveredUnits,
      deliveredNetFils: n(row.deliveredNet),
      shareBps: rateBps(n(row.deliveredNet), total),
    })),
    brands: brands.map((row) => ({
      brandName: row.brandName,
      orderedUnits: row.orderedUnits,
      deliveredUnits: row.deliveredUnits,
      deliveredNetFils: n(row.deliveredNet),
    })),
  };
}

async function search(tx: Tx, from: string, to: string) {
  const range = Prisma.sql`day BETWEEN ${from}::date AND ${to}::date`;
  const [totals] = await tx.$queryRaw<
    Array<{ searches: number; zero: number; notKept: number }>
  >(Prisma.sql`
    SELECT coalesce(sum(searches), 0)::int AS searches,
      coalesce(sum(zero_results), 0)::int AS zero,
      coalesce(sum(searches) FILTER (WHERE term = ''), 0)::int AS "notKept"
    FROM search_daily WHERE ${range}`);
  const terms = await tx.$queryRaw<Array<{ term: string; searches: number; zero: number }>>(
    Prisma.sql`
    SELECT term, sum(searches)::int AS searches, sum(zero_results)::int AS zero
    FROM search_daily WHERE ${range} AND term <> ''
    GROUP BY term ORDER BY searches DESC, term LIMIT 20`,
  );
  const zeroTerms = await tx.$queryRaw<Array<{ term: string; searches: number }>>(Prisma.sql`
    SELECT term, sum(zero_results)::int AS searches
    FROM search_daily WHERE ${range} AND term <> ''
    GROUP BY term HAVING sum(zero_results) > 0
    ORDER BY searches DESC, term LIMIT 20`);
  const days = await tx.$queryRaw<Array<{ day: string; searches: number; zero: number }>>(
    Prisma.sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(searches)::int AS searches,
      sum(zero_results)::int AS zero
    FROM search_daily WHERE ${range} GROUP BY day ORDER BY day`,
  );
  const { searches, zero, notKept } = totals!;
  return {
    searches,
    zeroResults: zero,
    zeroRateBps: rateBps(zero, searches),
    notKept,
    terms: terms.map((row) => ({ term: row.term, searches: row.searches, zeroResults: row.zero })),
    zeroTerms,
    days: days.map((row) => ({ day: row.day, searches: row.searches, zeroResults: row.zero })),
  };
}

async function wishlist(tx: Tx, from: string, to: string) {
  const range = Prisma.sql`w.day BETWEEN ${from}::date AND ${to}::date`;
  const [totals] = await tx.$queryRaw<Array<{ adds: number; removes: number }>>(Prisma.sql`
    SELECT coalesce(sum(adds), 0)::int AS adds, coalesce(sum(removes), 0)::int AS removes
    FROM wishlist_daily w WHERE ${range}`);
  const products = await tx.$queryRaw<
    Array<{ productId: string; name: string; adds: number; removes: number; outOfStock: boolean }>
  >(Prisma.sql`
    SELECT p.id AS "productId", p.name, sum(w.adds)::int AS adds, sum(w.removes)::int AS removes,
      NOT EXISTS (SELECT 1 FROM variants v
        WHERE v.product_id=p.id AND v.active AND v.stock_on_hand > 0) AS "outOfStock"
    FROM wishlist_daily w JOIN products p ON p.id=w.product_id
    WHERE ${range}
    GROUP BY p.id, p.name ORDER BY adds DESC, p.name, p.id LIMIT 20`);
  return { ...totals!, products };
}
