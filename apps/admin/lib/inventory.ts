import {
  stockAdjustmentRequestSchema,
  stockSetRequestSchema,
  type StockAdjustmentRequest,
  type StockSetRequest,
} from "@ih/contracts";
import { FormValidationError, validate } from "./management";

const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
function units(data: FormData, field: string): number {
  const raw = text(data, field);
  if (!/^\d{1,9}$/.test(raw)) throw new FormValidationError("Enter a whole number of units.");
  return Number(raw);
}
const note = (data: FormData) => text(data, "note") || undefined;

/** Add received units (restock). */
export function addCommand(commandId: string, data: FormData): StockAdjustmentRequest {
  const quantity = units(data, "quantity");
  if (quantity === 0) throw new FormValidationError("Enter at least one unit.");
  return validate(stockAdjustmentRequestSchema, {
    commandId,
    reason: "RESTOCK",
    delta: quantity,
    note: note(data),
  });
}
/** Remove units: damage or a manual correction, always explained. */
export function removeCommand(commandId: string, data: FormData): StockAdjustmentRequest {
  const quantity = units(data, "quantity");
  if (quantity === 0) throw new FormValidationError("Enter at least one unit.");
  const reason = text(data, "reason") === "DAMAGE" ? "DAMAGE" : "MANUAL";
  return validate(stockAdjustmentRequestSchema, {
    commandId,
    reason,
    delta: -quantity,
    note: note(data),
  });
}
/** Set an absolute count against the balance the user saw. */
export function setCommand(commandId: string, expected: number, data: FormData): StockSetRequest {
  return validate(stockSetRequestSchema, {
    commandId,
    expectedStockOnHand: expected,
    targetStockOnHand: units(data, "target"),
    note: note(data),
  });
}
export const reasonLabel: Record<string, string> = {
  INITIAL_STOCK: "Initial stock",
  RESTOCK: "Restock",
  MANUAL: "Manual correction",
  DAMAGE: "Damaged",
  SALE: "Sold in an order",
  ORDER_EDIT: "Changed by an order edit",
  ORDER_CANCEL: "Back in stock from a cancelled order",
  ORDER_RETURN: "Returned item put back in stock",
};

export type StockState = "in_stock" | "low" | "out";
/** The server's rule (`stockState` in @ih/db): out at zero, low at or below the alert. */
export function stockStateFor(stock: number, threshold: number): StockState {
  if (stock <= 0) return "out";
  return stock <= threshold ? "low" : "in_stock";
}
/** The preview in the update drawer: the balance a change would leave (negative = too many). */
export function stockAfter(mode: "add" | "remove" | "set", current: number, quantity: number) {
  if (mode === "add") return current + quantity;
  if (mode === "remove") return current - quantity;
  return quantity;
}
