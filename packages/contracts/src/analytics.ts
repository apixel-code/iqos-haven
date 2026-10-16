import { z } from "zod";

/**
 * Financial summary (roadmap step 105, ADR 0071). Owner only (`dashboard.financial_read`).
 * Three bases kept apart, each labelled with its date basis; Asia/Dubai calendar days; AED in
 * integer fils; no separate tax line (prices are final as entered).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const financialSummaryQuerySchema = z.strictObject({ from: isoDate, to: isoDate });
export type FinancialSummaryQuery = z.infer<typeof financialSummaryQuerySchema>;

const fils = z.number().int().min(0);
const count = z.number().int().min(0);
const average = z.number().int().min(0).nullable();
const sales = z.strictObject({
  orders: count,
  merchandiseNetFils: fils,
  deliveryFils: fils,
  totalFils: fils,
  aovFils: average,
});
export const ORDER_STATUSES_FOR_MIX = [
  "pending",
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;
export const financialSummarySchema = z.strictObject({
  range: z.strictObject({
    from: isoDate,
    to: isoDate,
    days: z.number().int().min(1).max(366),
    timezone: z.literal("Asia/Dubai"),
  }),
  currency: z.literal("AED"),
  taxNote: z.string(),
  definitionVersion: z.number().int().min(1),
  /** Placed in the range; active = not cancelled now. AOV is over active orders. */
  booked: z.strictObject({
    dateBasis: z.string(),
    active: sales,
    cancelled: z.strictObject({ orders: count, totalFils: fils }),
  }),
  /** Delivered in the range (by delivered_at). */
  delivered: sales.extend({ dateBasis: z.string() }),
  /** Cash collected in the range: each order's latest collection record. */
  collected: z.strictObject({
    dateBasis: z.string(),
    orders: count,
    amountFils: fils,
    aovFils: average,
  }),
  /** Placement cohort: placed in the range and cancelled now. */
  cancellation: z.strictObject({
    dateBasis: z.string(),
    placed: count,
    cancelled: count,
    rateBps: z.number().int().min(0).max(10_000).nullable(),
  }),
  /** Orders placed in the range by their current status. */
  statusMix: z.record(z.enum(ORDER_STATUSES_FOR_MIX), count),
});
export type FinancialSummary = z.infer<typeof financialSummarySchema>;

/**
 * Owner analytics (roadmap step 109, ADR 0075): `GET /v1/admin/analytics?from&to`, Owner only
 * (`dashboard.financial_read`). Read from the daily tables of step 106, so every answer says
 * which days were computed and when; a day not computed is listed in `freshness.missing` and
 * counts as nothing, never as zero sales. Same definitions as the summary (ADR 0071).
 */
export const analyticsQuerySchema = financialSummaryQuerySchema;
export type AnalyticsQuery = FinancialSummaryQuery;
const rate = z.number().int().min(0).max(10_000).nullable();
const name = z.string().min(1).max(150);
export const analyticsSchema = z.strictObject({
  range: financialSummarySchema.shape.range,
  currency: z.literal("AED"),
  taxNote: z.string(),
  definitionVersion: z.number().int().min(1),
  freshness: z.strictObject({
    computedDays: count,
    missing: z.array(isoDate).max(366),
    oldestComputedAt: z.iso.datetime().nullable(),
    newestComputedAt: z.iso.datetime().nullable(),
  }),
  totals: z.strictObject({
    placed: count,
    booked: sales,
    cancelled: z.strictObject({ orders: count, totalFils: fils, rateBps: rate }),
    delivered: sales,
    collected: z.strictObject({ orders: count, amountFils: fils, aovFils: average }),
  }),
  /** The same number of days just before `from`, for comparison. */
  previous: z.strictObject({
    from: isoDate,
    to: isoDate,
    missingDays: count,
    bookedOrders: count,
    bookedTotalFils: fils,
    aovFils: average,
    cancellationRateBps: rate,
  }),
  /** One entry per computed day, oldest first. */
  days: z
    .array(
      z.strictObject({
        day: isoDate,
        placed: count,
        cancelled: count,
        bookedOrders: count,
        bookedTotalFils: fils,
        deliveredOrders: count,
        deliveredTotalFils: fils,
        collectedFils: fils,
      }),
    )
    .max(366),
  /** Orders placed in the range by their status now (live, not from the daily tables). */
  statusMix: z.record(z.enum(ORDER_STATUSES_FOR_MIX), count),
  /** Ranked by delivered net (merchandise after discount), then units ordered. */
  products: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        name,
        orderedUnits: count,
        orderedNetFils: fils,
        deliveredUnits: count,
        deliveredNetFils: fils,
        /** Share of all delivered net in the range. */
        shareBps: rate,
      }),
    )
    .max(20),
  /** By the brand name snapshotted on each sale, so a renamed brand keeps its history. */
  brands: z
    .array(
      z.strictObject({
        brandName: name,
        orderedUnits: count,
        deliveredUnits: count,
        deliveredNetFils: fils,
      }),
    )
    .max(20),
  search: z.strictObject({
    searches: count,
    zeroResults: count,
    zeroRateBps: rate,
    /** Searches whose term was not kept because it might be personal (ADR 0069). */
    notKept: count,
    terms: z.array(z.strictObject({ term: name, searches: count, zeroResults: count })).max(20),
    zeroTerms: z.array(z.strictObject({ term: name, searches: count })).max(20),
    days: z.array(z.strictObject({ day: isoDate, searches: count, zeroResults: count })).max(366),
  }),
  /** Device activity, not unique customers. */
  wishlist: z.strictObject({
    adds: count,
    removes: count,
    products: z
      .array(
        z.strictObject({
          productId: z.uuid(),
          name,
          adds: count,
          removes: count,
          /** No active variant has stock now. */
          outOfStock: z.boolean(),
        }),
      )
      .max(20),
  }),
});
export type Analytics = z.infer<typeof analyticsSchema>;
