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
};
