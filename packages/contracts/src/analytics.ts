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
