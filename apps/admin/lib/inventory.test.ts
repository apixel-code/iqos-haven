import { describe, expect, it } from "vitest";
import { FormValidationError } from "./management";
import { addCommand, removeCommand, setCommand, stockAfter, stockStateFor } from "./inventory";

const id = "0199c0de-0000-7000-8000-000000000001";
const data = (entries: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(entries)) result.set(key, value);
  return result;
};

describe("inventory form commands", () => {
  it("builds restock, removal and set commands with the given command ID", () => {
    expect(addCommand(id, data({ quantity: "12" }))).toEqual({
      commandId: id,
      reason: "RESTOCK",
      delta: 12,
    });
    expect(removeCommand(id, data({ quantity: "2", reason: "DAMAGE", note: "Leaking" }))).toEqual({
      commandId: id,
      reason: "DAMAGE",
      delta: -2,
      note: "Leaking",
    });
    expect(removeCommand(id, data({ quantity: "1", note: "Count" })).reason).toBe("MANUAL");
    expect(setCommand(id, 8, data({ target: "5", note: "Shelf count" }))).toEqual({
      commandId: id,
      expectedStockOnHand: 8,
      targetStockOnHand: 5,
      note: "Shelf count",
    });
  });

  it("rejects missing explanations, fractions and zero quantities before sending", () => {
    for (const run of [
      () => removeCommand(id, data({ quantity: "2" })),
      () => addCommand(id, data({ quantity: "0" })),
      () => addCommand(id, data({ quantity: "1.5" })),
      () => setCommand(id, 3, data({ target: "-1", note: "x" })),
      () => setCommand(id, 3, data({ target: "4" })),
    ])
      expect(run).toThrow(FormValidationError);
  });
});

describe("stock preview", () => {
  it("follows the server's states: out at zero, low at or below the alert", () => {
    expect(stockStateFor(0, 5)).toBe("out");
    expect(stockStateFor(5, 5)).toBe("low");
    expect(stockStateFor(6, 5)).toBe("in_stock");
    expect(stockStateFor(1, 0)).toBe("in_stock");
  });
  it("computes the balance after each kind of change", () => {
    expect(stockAfter("add", 3, 10)).toBe(13);
    expect(stockAfter("remove", 3, 5)).toBe(-2);
    expect(stockAfter("set", 3, 0)).toBe(0);
  });
});
