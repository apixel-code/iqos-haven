import {
  financialSummaryQuerySchema,
  financialSummarySchema,
  ORDER_STATUSES_FOR_MIX,
  type FinancialSummary,
  type FinancialSummaryQuery,
} from "@ih/contracts";
import {
  averageFils,
  dubaiDayRange,
  METRIC_DEFINITION_VERSION,
  METRIC_DEFINITIONS,
  rateBps,
  TAX_NOTE,
} from "@ih/domain";
import { Prisma, type Database } from "./client";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";

export class FinancialReadForbiddenError extends Error {}

/**
 * The Owner's financial summary for Dubai days `from`..`to` (roadmap step 105, ADR 0071). One
 * repeatable-read snapshot so the three bases agree with each other. Live orders only, read
 * straight from the authoritative tables; the daily tables of step 106 will serve long ranges.
 */
export async function readFinancialSummary(
  db: Database,
  actorId: string,
  input: FinancialSummaryQuery,
): Promise<FinancialSummary> {
  const query = financialSummaryQuerySchema.parse(input);
  // Throws MetricRangeError for an impossible or over-long range.
  const { start, end, days } = dubaiDayRange(query.from, query.to);
  const net = Prisma.sql`(o.merchandise_subtotal_fils - o.discount_fils)`;
  return db.$transaction(
    async (tx) => {
      // Inside the snapshot: a right revoked meanwhile is seen.
      try {
        await lockCatalogueActor(tx, actorId, ["dashboard.financial_read"], false);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new FinancialReadForbiddenError();
        throw error;
      }
      const [booked] = await tx.$queryRaw<
        Array<{
          active: number;
          activeNet: bigint;
          activeDelivery: bigint;
          activeTotal: bigint;
          cancelled: number;
          cancelledTotal: bigint;
        }>
      >(Prisma.sql`
        SELECT count(*) FILTER (WHERE o.status <> 'cancelled')::int AS active,
          coalesce(sum(${net}) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint AS "activeNet",
          coalesce(sum(o.delivery_fee_fils) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint
            AS "activeDelivery",
          coalesce(sum(o.total_fils) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint
            AS "activeTotal",
          count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
          coalesce(sum(o.total_fils) FILTER (WHERE o.status = 'cancelled'), 0)::bigint
            AS "cancelledTotal"
        FROM orders o WHERE o.created_at >= ${start}::timestamptz AND o.created_at < ${end}::timestamptz`);
      const [delivered] = await tx.$queryRaw<
        Array<{ orders: number; net: bigint; delivery: bigint; total: bigint }>
      >(Prisma.sql`
        SELECT count(*)::int AS orders, coalesce(sum(${net}), 0)::bigint AS net,
          coalesce(sum(o.delivery_fee_fils), 0)::bigint AS delivery,
          coalesce(sum(o.total_fils), 0)::bigint AS total
        FROM orders o
        WHERE o.status = 'delivered' AND o.delivered_at >= ${start}::timestamptz AND o.delivered_at < ${end}::timestamptz`);
      // The latest record per order is in effect (corrections replace, never add).
      const [collected] = await tx.$queryRaw<Array<{ orders: number; amount: bigint }>>(Prisma.sql`
        SELECT count(*)::int AS orders, coalesce(sum(r.amount_fils), 0)::bigint AS amount
        FROM orders o
        JOIN LATERAL (
          SELECT c.amount_fils, c.collected_at FROM order_collection_records c
          WHERE c.order_id = o.id ORDER BY c.seq DESC LIMIT 1) r ON true
        WHERE o.cod_status = 'collected'
          AND r.collected_at >= ${start}::timestamptz AND r.collected_at < ${end}::timestamptz`);
      const mix = await tx.$queryRaw<Array<{ status: string; n: number }>>(Prisma.sql`
        SELECT o.status, count(*)::int AS n FROM orders o
        WHERE o.created_at >= ${start}::timestamptz AND o.created_at < ${end}::timestamptz GROUP BY o.status`);
      const statusMix = Object.fromEntries(
        ORDER_STATUSES_FOR_MIX.map((status) => [
          status,
          mix.find((row) => row.status === status)?.n ?? 0,
        ]),
      ) as FinancialSummary["statusMix"];
      const placed = booked!.active + booked!.cancelled;
      return financialSummarySchema.parse({
        range: { from: query.from, to: query.to, days, timezone: "Asia/Dubai" },
        currency: "AED",
        taxNote: TAX_NOTE,
        definitionVersion: METRIC_DEFINITION_VERSION,
        booked: {
          dateBasis: METRIC_DEFINITIONS.booked.dateBasis,
          active: {
            orders: booked!.active,
            merchandiseNetFils: Number(booked!.activeNet),
            deliveryFils: Number(booked!.activeDelivery),
            totalFils: Number(booked!.activeTotal),
            aovFils: averageFils(booked!.activeTotal, booked!.active),
          },
          cancelled: { orders: booked!.cancelled, totalFils: Number(booked!.cancelledTotal) },
        },
        delivered: {
          dateBasis: METRIC_DEFINITIONS.delivered.dateBasis,
          orders: delivered!.orders,
          merchandiseNetFils: Number(delivered!.net),
          deliveryFils: Number(delivered!.delivery),
          totalFils: Number(delivered!.total),
          aovFils: averageFils(delivered!.total, delivered!.orders),
        },
        collected: {
          dateBasis: METRIC_DEFINITIONS.collected.dateBasis,
          orders: collected!.orders,
          amountFils: Number(collected!.amount),
          aovFils: averageFils(collected!.amount, collected!.orders),
        },
        cancellation: {
          dateBasis: METRIC_DEFINITIONS.cancellationRate.dateBasis,
          placed,
          cancelled: booked!.cancelled,
          rateBps: rateBps(booked!.cancelled, placed),
        },
        statusMix,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
