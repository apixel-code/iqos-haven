import { z } from "zod";
import { ORDER_STATUSES } from "@ih/domain";

/**
 * Operational home dashboard (roadmap step 108, ADR 0074). Every signed-in staff member may
 * ask; each section is present only when the caller holds its permission now and is `null`
 * otherwise, so the API (not the UI) decides what Staff sees. Counts are live; the sales figures
 * come from the daily tables with their freshness. AED in integer fils, Asia/Dubai days.
 */
const count = z.number().int().min(0);
const fils = z.number().int().min(0);
const orderLine = z.strictObject({
  id: z.uuid(),
  orderNumber: z.string().regex(/^IH-\d{6,}$/),
  status: z.enum(ORDER_STATUSES),
  createdAt: z.iso.datetime(),
  /** Over the waiting limit for its state (see `delayedAfterMinutes`). */
  delayed: z.boolean(),
  totalFils: fils,
  /** Only with `customers.read`; never the phone or address. */
  customerName: z.string().min(1).max(100).nullable(),
});
const salesDay = z
  .strictObject({
    day: z.iso.date(),
    /** Booked (placed, not cancelled), by placement day. */
    orders: count,
    totalFils: fils,
    aovFils: fils.nullable(),
    cancelledOrders: count,
    /** When the day was last recomputed. */
    computedAt: z.iso.datetime(),
  })
  /** `null` while the day has not been computed yet: not zero. */
  .nullable();

export const adminDashboardSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  timezone: z.literal("Asia/Dubai"),
  /** `orders.read` */
  orders: z
    .strictObject({
      open: z.strictObject({
        pending: count,
        confirmed: count,
        processing: count,
        outForDelivery: count,
      }),
      delayed: count,
      delayedAfterMinutes: z.strictObject({ pending: count, inProgress: count }),
      placedToday: count,
      /** Orders placed yesterday up to the same time of day. */
      placedYesterdaySoFar: count,
      /** Oldest pending or delayed open orders first. */
      attention: z.array(orderLine).max(5),
      recent: z.array(orderLine).max(7),
    })
    .nullable(),
  /** `inventory.read`: active variants of published products at or below their alert level. */
  stock: z
    .strictObject({
      low: count,
      out: count,
      items: z
        .array(
          z.strictObject({
            variantId: z.uuid(),
            productId: z.uuid(),
            productName: z.string().min(1).max(150),
            sku: z.string().min(1).max(64),
            stock: z.number().int(),
            threshold: count,
          }),
        )
        .max(5),
    })
    .nullable(),
  /** `reviews.moderate` */
  reviews: z.strictObject({ pending: count }).nullable(),
  /** `orders.read`: units ordered over the last seven Dubai days (orders not cancelled). */
  topProducts: z
    .strictObject({
      from: z.iso.date(),
      to: z.iso.date(),
      items: z
        .array(
          z.strictObject({
            productId: z.uuid(),
            name: z.string().min(1).max(150),
            units: count,
            /** Merchandise net after discounts; only with `dashboard.financial_read`. */
            netFils: fils.nullable(),
          }),
        )
        .max(5),
    })
    .nullable(),
  /** `dashboard.financial_read` */
  sales: z
    .strictObject({
      currency: z.literal("AED"),
      taxNote: z.string().min(1),
      today: salesDay,
      yesterday: salesDay,
    })
    .nullable(),
});
export type AdminDashboard = z.infer<typeof adminDashboardSchema>;
