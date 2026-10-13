import { z } from "zod";
import { COD_STATUSES, ORDER_SOURCES, ORDER_STATUSES } from "@ih/domain";
import { customerAddressTypeSchema } from "./customers";
import { filsSchema } from "./index";

export const adminOrderStatusSchema = z.enum(ORDER_STATUSES);
export const adminOrderParamsSchema = z.strictObject({ id: z.uuid() });
export const orderTransitionTargetSchema = z.enum([
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
]);
export const orderTransitionRequestSchema = z.strictObject({
  to: orderTransitionTargetSchema,
  expectedVersion: z.number().int().min(1),
  commandId: z.uuid(),
});
export const orderTransitionResponseSchema = z.strictObject({
  orderId: z.uuid(),
  fromStatus: adminOrderStatusSchema,
  toStatus: orderTransitionTargetSchema,
  orderVersion: z.number().int().min(2),
  transitionedAt: z.iso.datetime(),
  actor: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(100) }),
  replayed: z.boolean(),
});

const boundedInstant = z.iso.datetime({ offset: true });
export const adminOrdersQuerySchema = z
  .strictObject({
    status: adminOrderStatusSchema.optional(),
    from: boundedInstant.optional(),
    to: boundedInstant.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .refine((value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), {
    path: ["to"],
    message: "The end must be after the start",
  });

export const adminOrderContactSchema = z.strictObject({
  name: z.string().min(1).max(100),
  phone: z.string().min(1).max(16),
});

export const adminOrderSummarySchema = z.strictObject({
  id: z.uuid(),
  orderNumber: z.string().regex(/^IH-\d{6,}$/),
  status: adminOrderStatusSchema,
  source: z.enum(ORDER_SOURCES),
  customer: adminOrderContactSchema.optional(),
  itemCount: z.number().int().min(1),
  areaName: z.string().min(1).max(100),
  totalFils: filsSchema,
  codStatus: z.enum(COD_STATUSES),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
});

export const adminOrdersResponseSchema = z.strictObject({
  items: z.array(adminOrderSummarySchema).max(100),
  nextCursor: z.string().max(300).nullable(),
});

const adminOrderAddressSchema = z.strictObject({
  type: customerAddressTypeSchema,
  building: z.string().min(1).max(150),
  unit: z.string().max(50).nullable(),
  street: z.string().max(150).nullable(),
  makani: z.string().max(10).nullable(),
  notes: z.string().max(500).nullable(),
});

const adminOrderCustomerSchema = adminOrderContactSchema.extend({
  address: adminOrderAddressSchema,
});
const adminOrderItemSchema = z.strictObject({
  id: z.uuid(),
  productName: z.string().min(1).max(150),
  productSlug: z.string().min(1).max(150),
  brandName: z.string().min(1).max(150),
  categoryName: z.string().min(1).max(150),
  sku: z.string().min(1).max(64),
  attributes: z.record(z.string(), z.string()),
  unitPriceFils: filsSchema,
  quantity: z.number().int().min(1),
  subtotalFils: filsSchema,
  discountFils: filsSchema,
  totalFils: filsSchema,
});
const adminOrderHistorySchema = z.strictObject({
  id: z.uuid(),
  fromStatus: adminOrderStatusSchema.nullable(),
  toStatus: adminOrderStatusSchema,
  reason: z.string().max(500).nullable(),
  actorKind: z.enum(["customer", "staff", "system"]),
  actorName: z.string().min(1).max(100).nullable(),
  orderVersion: z.number().int().min(1),
  createdAt: z.iso.datetime(),
});

export const adminOrderResponseSchema = z.strictObject({
  id: z.uuid(),
  orderNumber: z.string().regex(/^IH-\d{6,}$/),
  status: adminOrderStatusSchema,
  source: z.enum(ORDER_SOURCES),
  customer: adminOrderCustomerSchema.optional(),
  area: z.strictObject({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    emirate: z.string().min(1).max(16),
  }),
  merchandiseSubtotalFils: filsSchema,
  discountFils: filsSchema,
  deliveryFeeFils: filsSchema,
  totalFils: filsSchema,
  coupon: z
    .strictObject({
      code: z.string().min(1).max(32),
      percentBps: z.number().int().min(1).max(10_000),
    })
    .nullable(),
  deliveryEtaText: z.string().min(1).max(500),
  codStatus: z.enum(COD_STATUSES),
  collectedAmountFils: filsSchema.nullable(),
  collectedAt: z.iso.datetime().nullable(),
  collectionReference: z.string().max(100).nullable(),
  cancelReason: z.string().max(500).nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  returnedAt: z.iso.datetime().nullable(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  items: z.array(adminOrderItemSchema).min(1),
  history: z.array(adminOrderHistorySchema).min(1),
});

export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;
export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;
export type AdminOrdersResponse = z.infer<typeof adminOrdersResponseSchema>;
export type AdminOrderResponse = z.infer<typeof adminOrderResponseSchema>;
export type OrderTransitionRequest = z.infer<typeof orderTransitionRequestSchema>;
export type OrderTransitionResponse = z.infer<typeof orderTransitionResponseSchema>;
