import { z } from "zod";
import { COD_STATUSES, ORDER_SOURCES, ORDER_STATUSES } from "@ih/domain";
import { customerAddressTypeSchema } from "./customers";
import { checkoutAddressSchema, checkoutContactSchema, orderLinesSchema } from "./checkout";
import { couponCodeInputSchema } from "./coupons";
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

// --- Bulk confirm (roadmap step 89, ADR 0057) ---
export const BULK_CONFIRM_LIMIT = 50;
/**
 * Confirms several Pending orders, each as its own versioned transition with its own command
 * ID, so a retry of the same batch replays instead of confirming twice.
 */
export const orderBulkConfirmRequestSchema = z
  .strictObject({
    orders: z
      .array(
        z.strictObject({
          // One spelling, so a retry written in capitals is still the same command.
          orderId: z.uuid().transform((id) => id.toLowerCase()),
          expectedVersion: z.number().int().min(1),
          commandId: z.uuid().transform((id) => id.toLowerCase()),
        }),
      )
      .min(1)
      .max(BULK_CONFIRM_LIMIT),
  })
  .refine(
    (value) =>
      new Set(value.orders.map((item) => item.orderId)).size === value.orders.length &&
      new Set(value.orders.map((item) => item.commandId)).size === value.orders.length,
    { path: ["orders"], message: "Each order and each command once" },
  );
export const orderBulkConfirmResponseSchema = z.strictObject({
  results: z
    .array(
      z.strictObject({
        orderId: z.uuid(),
        /** `confirmed`, also when this command had already confirmed it (`replayed`). */
        outcome: z.enum(["confirmed", "refused"]),
        /** Why it was refused: a conflict code, `NOT_FOUND` or `FORBIDDEN`. */
        code: z.string().max(64).nullable(),
        orderVersion: z.number().int().min(2).nullable(),
        replayed: z.boolean(),
      }),
    )
    .max(BULK_CONFIRM_LIMIT),
});

export const orderEditRequestSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    commandId: z.uuid(),
    lines: orderLinesSchema.optional(),
    couponCode: z.string().trim().min(3).max(32).nullable().optional(),
    address: checkoutAddressSchema.optional(),
    operationalNote: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .refine(
    (value) =>
      value.lines !== undefined ||
      value.couponCode !== undefined ||
      value.address !== undefined ||
      value.operationalNote !== undefined,
    { message: "At least one edit is required" },
  );

const editLineDiffSchema = z.strictObject({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1),
});
export const orderEditDiffSchema = z.strictObject({
  items: z
    .strictObject({ before: z.array(editLineDiffSchema), after: z.array(editLineDiffSchema) })
    .optional(),
  coupon: z
    .strictObject({ before: z.string().nullable(), after: z.string().nullable() })
    .optional(),
  delivery: z
    .strictObject({
      beforeArea: z.string(),
      afterArea: z.string(),
      addressChanged: z.literal(true),
    })
    .optional(),
  operationalNote: z
    .strictObject({ before: z.string().nullable(), after: z.string().nullable() })
    .optional(),
  total: z.strictObject({ beforeFils: filsSchema, afterFils: filsSchema }).optional(),
});
const orderEditRecordSchema = z.strictObject({
  id: z.uuid(),
  orderVersion: z.number().int().min(2),
  actor: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(100) }),
  editedAt: z.iso.datetime(),
  diff: orderEditDiffSchema,
});
export const orderEditResponseSchema = orderEditRecordSchema.extend({
  orderId: z.uuid(),
  replayed: z.boolean(),
});

// --- Manual orders (roadmap step 88, ADR 0056) ---
export const MANUAL_CONFIRMATION_CHANNELS = ["phone", "whatsapp", "in_person"] as const;
/**
 * An order a staff member enters for a customer. Priced by the same server quote (its token is
 * sent back), stock and coupon rules as a store order. It starts Pending, or Confirmed when the
 * staff member records how the customer confirmed it. The staff member attests the customer
 * said they are 18 or older. The attempt key travels in the `Idempotency-Key` header.
 */
export const manualOrderRequestSchema = z
  .strictObject({
    contact: checkoutContactSchema,
    address: checkoutAddressSchema,
    lines: orderLinesSchema,
    couponCode: couponCodeInputSchema,
    quoteToken: z.string().min(1).max(256),
    ageConfirmed: z.literal(true),
    start: z.enum(["pending", "confirmed"]),
    evidence: z
      .strictObject({
        channel: z.enum(MANUAL_CONFIRMATION_CHANNELS),
        note: z.string().trim().min(1).max(300),
      })
      .optional(),
  })
  .refine((value) => (value.start === "confirmed") === (value.evidence !== undefined), {
    path: ["evidence"],
    message: "Confirmed needs evidence; Pending takes none",
  });
export const manualOrderResponseSchema = z.strictObject({
  orderId: z.uuid(),
  orderNumber: z.string().regex(/^IH-\d{6,}$/),
  status: z.enum(["pending", "confirmed"]),
  totalFils: filsSchema,
  placedAt: z.iso.datetime(),
  replayed: z.boolean(),
});

// --- Item picker for manual orders and order edits (parity G-A1, ADR 0080) ---
export const orderItemChoicesQuerySchema = z.strictObject({
  /** Product name, brand or SKU; empty lists the first choices. */
  q: z.string().trim().max(100).optional(),
});
/**
 * Variants an order can take now: the store's visibility rule, an active variant and a price.
 * The unit price is for display only; the server quote stays authoritative. Stock is shown as
 * sold out or not, never as a count (that needs `inventory.read`).
 */
export const orderItemChoicesResponseSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        productName: z.string().min(1).max(150),
        brandName: z.string().min(1).max(150),
        sku: z.string().min(1).max(64),
        /** Option values in the product's option order, e.g. "Mint · 20 mg"; empty without options. */
        options: z.string().max(400),
        unitPriceFils: filsSchema,
        soldOut: z.boolean(),
      }),
    )
    .max(30),
});
export type OrderItemChoicesQuery = z.infer<typeof orderItemChoicesQuerySchema>;
export type OrderItemChoicesResponse = z.infer<typeof orderItemChoicesResponseSchema>;
export type OrderItemChoice = OrderItemChoicesResponse["items"][number];

// --- Cancellation (roadmap step 86, ADR 0054) ---
const returnItemSchema = z.strictObject({
  variantId: z.uuid(),
  resellableQuantity: z.number().int().min(0).max(10_000),
  damagedQuantity: z.number().int().min(0).max(10_000),
});
/**
 * Cancels an order. Before handoff (Pending, Confirmed, Processing) a reason is enough and every
 * unit goes back to stock. Out for Delivery is a return: Owner only, after the goods came back,
 * with every line classified as resellable or damaged; only resellable units are restocked.
 */
export const orderCancelRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  commandId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  returnItems: z.array(returnItemSchema).min(1).max(100).optional(),
});
const cancelLineSchema = z.strictObject({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1),
});
export const orderCancelResponseSchema = z.strictObject({
  orderId: z.uuid(),
  kind: z.enum(["before_handoff", "returned"]),
  fromStatus: adminOrderStatusSchema,
  orderVersion: z.number().int().min(2),
  reason: z.string().min(1).max(500),
  cancelledAt: z.iso.datetime(),
  actor: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(100) }),
  /** Units put back in stock, per SKU. */
  restocked: z.array(cancelLineSchema),
  /** Returned units recorded as damaged and not restocked, per SKU. */
  damaged: z.array(cancelLineSchema),
  couponReleased: z.boolean(),
  replayed: z.boolean(),
});

// --- Cash-on-delivery collection (roadmap step 87, ADR 0055) ---
const collectionAmountSchema = z.number().int().min(0).max(1_000_000_000_000);
const collectionReferenceSchema = z.string().trim().min(1).max(100).nullable();
/** Records the cash for a Delivered order: what was received, when, and a reference. */
export const orderCollectionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  commandId: z.uuid(),
  amountFils: collectionAmountSchema,
  reference: collectionReferenceSchema.optional(),
  /** When the cash was received; now if absent. Not before delivery, not in the future. */
  collectedAt: z.iso.datetime({ offset: true }).optional(),
});
/** The Owner's correction: the full corrected record and why. The original stays recorded. */
export const orderCollectionCorrectionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  commandId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  amountFils: collectionAmountSchema,
  reference: collectionReferenceSchema,
  collectedAt: z.iso.datetime({ offset: true }),
});
export const orderCollectionRecordSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["recorded", "corrected"]),
  orderVersion: z.number().int().min(2),
  amountFils: filsSchema,
  collectedAt: z.iso.datetime(),
  reference: z.string().max(100).nullable(),
  reason: z.string().max(500).nullable(),
  actor: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(100) }),
  recordedAt: z.iso.datetime(),
});
export const orderCollectionResponseSchema = orderCollectionRecordSchema.extend({
  orderId: z.uuid(),
  replayed: z.boolean(),
});

const boundedInstant = z.iso.datetime({ offset: true });
export const adminOrdersQuerySchema = z
  .strictObject({
    status: adminOrderStatusSchema.optional(),
    /** Only open orders waiting too long (the dashboard's "delayed" rule, ADR 0074). */
    delayed: z.literal("true").optional(),
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
  variantId: z.uuid().optional(),
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
    id: z.uuid().optional(),
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
  /**
   * The first cash record, kept as original evidence and never changed. After an Owner
   * correction the amount in effect is the last entry of `collectionRecords`.
   */
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
  operationalNote: z.string().max(500).nullable(),
  items: z.array(adminOrderItemSchema).min(1),
  history: z.array(adminOrderHistorySchema).min(1),
  edits: z.array(orderEditRecordSchema),
  /** The cash record and every correction, oldest first; the last one is in effect. */
  collectionRecords: z.array(orderCollectionRecordSchema),
  /** How each line came back, for an order cancelled after a return; otherwise empty. */
  returnItems: z.array(
    z.strictObject({
      sku: z.string().min(1).max(64),
      quantity: z.number().int().min(1),
      resellableQuantity: z.number().int().min(0),
      damagedQuantity: z.number().int().min(0),
    }),
  ),
});

export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;
export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;
export type AdminOrdersResponse = z.infer<typeof adminOrdersResponseSchema>;
export type AdminOrderResponse = z.infer<typeof adminOrderResponseSchema>;
export type OrderTransitionRequest = z.infer<typeof orderTransitionRequestSchema>;
export type OrderTransitionResponse = z.infer<typeof orderTransitionResponseSchema>;
export type OrderEditRequest = z.infer<typeof orderEditRequestSchema>;
export type OrderBulkConfirmRequest = z.input<typeof orderBulkConfirmRequestSchema>;
export type OrderBulkConfirmResponse = z.infer<typeof orderBulkConfirmResponseSchema>;
export type OrderEditResponse = z.infer<typeof orderEditResponseSchema>;
export type OrderEditDiff = z.infer<typeof orderEditDiffSchema>;
export type ManualOrderRequest = z.input<typeof manualOrderRequestSchema>;
export type ManualOrderResponse = z.infer<typeof manualOrderResponseSchema>;
export type OrderCancelRequest = z.infer<typeof orderCancelRequestSchema>;
export type OrderCancelResponse = z.infer<typeof orderCancelResponseSchema>;
export type OrderCollectionRequest = z.infer<typeof orderCollectionRequestSchema>;
export type OrderCollectionCorrectionRequest = z.infer<
  typeof orderCollectionCorrectionRequestSchema
>;
export type OrderCollectionResponse = z.infer<typeof orderCollectionResponseSchema>;
