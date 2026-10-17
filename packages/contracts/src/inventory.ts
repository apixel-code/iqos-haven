import { z } from "zod";
import { catalogueText } from "./catalogue";

/**
 * Inventory (roadmap steps 46–47, ADR 0017). Stock changes only through ledger movements; every
 * adjustment carries a client-generated command ID (replay-safe) and a reason.
 */
export const STOCK_REASONS = ["INITIAL_STOCK", "RESTOCK", "MANUAL", "DAMAGE"] as const;
/** Every reason a movement can have in the ledger: what staff may enter, plus order effects. */
export const STOCK_MOVEMENT_REASONS = [
  ...STOCK_REASONS,
  "SALE",
  "ORDER_EDIT",
  "ORDER_CANCEL",
  "ORDER_RETURN",
] as const;
export const stockAdjustmentRequestSchema = z
  .strictObject({
    /** One per user action; a retry with the same payload returns the original result. */
    commandId: z.uuid(),
    reason: z.enum(STOCK_REASONS),
    delta: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((value) => value !== 0, "Must not be zero"),
    note: catalogueText(1, 500).optional(),
  })
  .refine((v) => v.reason !== "INITIAL_STOCK" || v.delta > 0, {
    message: "Initial stock adds units",
    path: ["delta"],
  })
  .refine((v) => v.reason !== "RESTOCK" || v.delta > 0, {
    message: "Restock adds units",
    path: ["delta"],
  })
  .refine((v) => v.reason !== "DAMAGE" || v.delta < 0, {
    message: "Damage removes units",
    path: ["delta"],
  })
  .refine((v) => !["DAMAGE", "MANUAL"].includes(v.reason) || v.note !== undefined, {
    message: "Explain this adjustment",
    path: ["note"],
  });

export const stockStateSchema = z.enum(["in_stock", "low", "out"]);
export const inventoryItemSchema = z.strictObject({
  variantId: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  productStatus: z.enum(["draft", "published"]),
  sku: z.string(),
  attributes: z.record(z.string(), z.string()),
  stockOnHand: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0),
  stockState: stockStateSchema,
  active: z.boolean(),
});
export const inventoryQuerySchema = z.strictObject({
  productId: z.uuid().optional(),
  /** One variant, e.g. from a low-stock notification (parity G-A2). */
  variantId: z.uuid().optional(),
  state: stockStateSchema.optional(),
  /** SKU or product name, matched literally. */
  q: catalogueText(1, 100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.uuid().optional(),
});
export const inventoryResponseSchema = z.strictObject({
  items: z.array(inventoryItemSchema).max(100),
  nextCursor: z.uuid().nullable(),
});

export const stockMovementSchema = z.strictObject({
  id: z.uuid(),
  delta: z.number().int(),
  balanceAfter: z.number().int().min(0),
  reason: z.enum(STOCK_MOVEMENT_REASONS),
  note: z.string().nullable(),
  actor: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
export const stockMovementsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Keyset over movement id descending (newest first). */
  before: z.uuid().optional(),
});
export const stockMovementsResponseSchema = z.strictObject({
  item: inventoryItemSchema,
  movements: z.array(stockMovementSchema).max(100),
  nextCursor: z.uuid().nullable(),
});
export const stockAdjustmentResponseSchema = z.strictObject({
  item: inventoryItemSchema,
  movement: stockMovementSchema,
  /** True when this command ID had already been applied and nothing changed now. */
  replayed: z.boolean(),
});
/**
 * Absolute set from a physical count (step 47): applied only if the balance still equals the one
 * the user saw; the server computes the delta under the row lock. Always explained.
 */
export const stockSetRequestSchema = z.strictObject({
  commandId: z.uuid(),
  expectedStockOnHand: z.number().int().min(0).max(100_000_000),
  targetStockOnHand: z.number().int().min(0).max(100_000_000),
  note: catalogueText(1, 500),
});
export const stockSetResponseSchema = z.strictObject({
  item: inventoryItemSchema,
  /** Null when the target already equals the balance (nothing recorded). */
  movement: stockMovementSchema.nullable(),
  replayed: z.boolean(),
});
export const inventoryVariantParamsSchema = z.strictObject({ variantId: z.uuid() });

export type StockAdjustmentRequest = z.input<typeof stockAdjustmentRequestSchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type InventoryQuery = z.input<typeof inventoryQuerySchema>;
export type StockMovement = z.infer<typeof stockMovementSchema>;
export type StockMovementsQuery = z.input<typeof stockMovementsQuerySchema>;
export type StockAdjustmentResponse = z.infer<typeof stockAdjustmentResponseSchema>;
export type StockSetRequest = z.input<typeof stockSetRequestSchema>;
export type StockSetResponse = z.infer<typeof stockSetResponseSchema>;
