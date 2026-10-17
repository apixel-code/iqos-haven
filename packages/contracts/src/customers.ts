import { z } from "zod";
/** One phone identity on both sides: the admin looks a customer up the way orders store it. */
export { InvalidPhoneError, normalizePhone } from "@ih/domain";
/** Stored customer phone identity. Typed input is normalized by `normalizePhone` first. */
export const phoneE164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const customerAddressTypeSchema = z.enum(["apartment", "villa", "office"]);
const line = (max: number) => z.string().min(1).max(max);
/** Storage bounds of a saved address (already normalized). Per-type rules are step 66. */
export const customerAddressSchema = z.strictObject({
  areaId: z.uuid(),
  type: customerAddressTypeSchema,
  building: line(150),
  unit: line(50).nullable(),
  street: line(150).nullable(),
  makani: z
    .string()
    .regex(/^\d{10}$/)
    .nullable(),
  notes: line(500).nullable(),
});
export type CustomerAddressType = z.infer<typeof customerAddressTypeSchema>;
export type CustomerAddress = z.infer<typeof customerAddressSchema>;

// --- Admin customer views (roadmap step 90, ADR 0058) ---
const filsAmount = z.number().int().min(0);
/**
 * Money a customer's orders add up to, Owner only (`customers.financial_read`). Two labelled
 * bases, never one mixed figure: booked = every order not cancelled; delivered = Delivered only.
 */
export const customerSpendSchema = z.strictObject({
  bookedFils: filsAmount,
  deliveredFils: filsAmount,
});
export const adminCustomersQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const adminCustomerSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  phone: phoneE164Schema,
  orderCount: z.number().int().min(0),
  lastOrderAt: z.iso.datetime().nullable(),
  /** The delivery area of the latest order. */
  areaName: z.string().max(100).nullable(),
  noShow: z.boolean(),
  spend: customerSpendSchema.optional(),
});
export const adminCustomersResponseSchema = z.strictObject({
  items: z.array(adminCustomerSummarySchema).max(100),
  nextCursor: z.string().max(300).nullable(),
});
export const adminCustomerResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  phone: phoneE164Schema,
  noShow: z.boolean(),
  createdAt: z.iso.datetime(),
  firstOrderAt: z.iso.datetime().nullable(),
  lastOrderAt: z.iso.datetime().nullable(),
  orderCount: z.number().int().min(0),
  cancelledCount: z.number().int().min(0),
  /** Newest first, at most 10. Saved addresses never change; a correction is a new one. */
  addresses: z
    .array(
      z.strictObject({
        id: z.uuid(),
        /** So a manual order for a returning customer can start from this address. */
        areaId: z.uuid(),
        areaName: z.string().min(1).max(100),
        emirate: z.string().min(1).max(16),
        type: customerAddressTypeSchema,
        building: z.string().min(1).max(150),
        unit: z.string().max(50).nullable(),
        street: z.string().max(150).nullable(),
        makani: z.string().max(10).nullable(),
        notes: z.string().max(500).nullable(),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(10),
  /** Newest first, at most 50; `orderCount` says how many there are. */
  orders: z
    .array(
      z.strictObject({
        id: z.uuid(),
        orderNumber: z.string().regex(/^IH-\d{6,}$/),
        status: z.enum([
          "pending",
          "confirmed",
          "processing",
          "out_for_delivery",
          "delivered",
          "cancelled",
        ]),
        codStatus: z.enum(["pending", "collected", "not_collected"]),
        totalFils: filsAmount,
        createdAt: z.iso.datetime(),
      }),
    )
    .max(50),
  spend: customerSpendSchema.optional(),
});
export const adminCustomerParamsSchema = z.strictObject({ id: z.uuid() });

// --- Order WhatsApp links (roadmap step 90, ADR 0058) ---
/**
 * Ready `wa.me` links for staff to message a customer about an order. Opening one does not
 * send anything and nothing is recorded: staff send it themselves in WhatsApp.
 */
export const orderWhatsappResponseSchema = z.strictObject({
  /** The customer's number, so staff can adjust the text and open the link again. */
  phone: phoneE164Schema,
  links: z
    .array(
      z.strictObject({
        kind: z.enum(["orderConfirmation", "statusUpdate"]),
        // Non-Latin text grows up to nine times when URL-encoded.
        href: z.url().max(20_000),
        text: z.string().min(1).max(2000),
        /** The wording is the built-in placeholder, not one the Owner set (BI-09). */
        placeholder: z.boolean(),
      }),
    )
    .max(2),
});
export type AdminCustomersQuery = z.infer<typeof adminCustomersQuerySchema>;
export type AdminCustomersResponse = z.infer<typeof adminCustomersResponseSchema>;
export type AdminCustomerResponse = z.infer<typeof adminCustomerResponseSchema>;
export type OrderWhatsappResponse = z.infer<typeof orderWhatsappResponseSchema>;
