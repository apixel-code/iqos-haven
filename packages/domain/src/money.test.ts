import { describe, expect, it } from "vitest";
import { addFils, applyBasisPoints, fils, formatAed, multiplyFils } from "./money";

describe("money (integer fils)", () => {
  it("rejects floats", () => {
    expect(() => fils(10.5)).toThrow(RangeError);
  });

  it("rounds basis-point percentages half-up", () => {
    expect(applyBasisPoints(fils(1050), 1500)).toBe(158); // 157.5 → 158
    expect(applyBasisPoints(fils(1030), 1500)).toBe(155); // 154.5 → 155
    expect(applyBasisPoints(fils(1010), 1500)).toBe(152); // 151.5 → 152
    expect(applyBasisPoints(fils(999), 500)).toBe(50); // 49.95 → 50
    expect(applyBasisPoints(fils(1000), 0)).toBe(0);
  });

  it("does not lose precision on large amounts", () => {
    expect(applyBasisPoints(fils(9_007_199_254_740), 10_000)).toBe(9_007_199_254_740);
  });

  it("adds and multiplies", () => {
    expect(addFils(fils(100), fils(250))).toBe(350);
    expect(multiplyFils(fils(1999), 3)).toBe(5997);
    expect(() => multiplyFils(fils(1), 1.5)).toThrow(RangeError);
  });

  it("formats AED for display", () => {
    expect(formatAed(fils(12350))).toBe("AED 123.50");
    expect(formatAed(fils(5))).toBe("AED 0.05");
    expect(formatAed(fils(123456789))).toBe("AED 1,234,567.89");
  });
});
