import { describe, expect, it } from "vitest";
import { mergeOrderLines, ORDER_LIMITS, OrderLinesError } from "./order-lines";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const problem = (lines: Parameters<typeof mergeOrderLines>[0]) => {
  try {
    mergeOrderLines(lines);
  } catch (error) {
    if (error instanceof OrderLinesError) return error.problem;
    throw error;
  }
  return null;
};
describe("order lines", () => {
  it("merges repeats of a variant and sorts by variant ID", () => {
    expect(
      mergeOrderLines([
        { variantId: id(2), quantity: 1 },
        { variantId: id(1), quantity: 4 },
        { variantId: id(2).toUpperCase(), quantity: 2 },
      ]),
    ).toEqual([
      { variantId: id(1), quantity: 4 },
      { variantId: id(2), quantity: 3 },
    ]);
  });
  it("accepts the caps exactly", () => {
    const full = Array.from({ length: ORDER_LIMITS.maxLines }, (_, n) => ({
      variantId: id(n),
      quantity: ORDER_LIMITS.maxLineQuantity,
    }));
    expect(mergeOrderLines(full)).toHaveLength(ORDER_LIMITS.maxLines);
  });
  it("refuses instead of clamping", () => {
    expect(problem([])).toBe("EMPTY");
    expect(
      problem(
        Array.from({ length: ORDER_LIMITS.maxLines + 1 }, (_, n) => ({
          variantId: id(n),
          quantity: 1,
        })),
      ),
    ).toBe("TOO_MANY_LINES");
    for (const quantity of [0, -1, 1.5, 11, Number.NaN, Number.MAX_SAFE_INTEGER, 2 ** 53])
      expect(problem([{ variantId: id(1), quantity }]), String(quantity)).toBe("QUANTITY");
    // Each line is within the cap; together they are not.
    expect(
      problem([
        { variantId: id(1), quantity: 6 },
        { variantId: id(1), quantity: 5 },
      ]),
    ).toBe("QUANTITY");
  });
});
