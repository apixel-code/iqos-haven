import { describe, expect, it } from "vitest";
import { ORDER_LIMITS } from "./order-lines";
import { allocateLargestRemainder, MAX_UNIT_PRICE_FILS, priceOrder } from "./pricing";
const line = (n: number, unitPriceFils: number, quantity = 1) => ({
  variantId: `v${String(n).padStart(3, "0")}`,
  unitPriceFils,
  quantity,
});
describe("largest-remainder allocation", () => {
  it("adds up exactly and gives the spare fils to the largest lost fractions", () => {
    // Exact shares 499.95, 499.95, 500.10: rounded down 499, 499, 500; two fils left over.
    expect(allocateLargestRemainder(1500, [3333, 3333, 3334])).toEqual([500, 500, 500]);
    // Exact shares 0.3, 0.3, 0.4: the single fil goes to the largest fraction.
    expect(allocateLargestRemainder(1, [3, 3, 4])).toEqual([0, 0, 1]);
    expect(allocateLargestRemainder(100, [100, 100, 100])).toEqual([34, 33, 33]);
  });
  it("settles equal fractions by position", () => {
    expect(allocateLargestRemainder(1, [5, 5])).toEqual([1, 0]);
    expect(allocateLargestRemainder(3, [1, 1, 1, 1])).toEqual([1, 1, 1, 0]);
    expect(allocateLargestRemainder(4, [1, 1, 1, 1])).toEqual([1, 1, 1, 1]);
  });
  it("handles zero amounts and weights, and refuses the impossible", () => {
    expect(allocateLargestRemainder(0, [5, 0])).toEqual([0, 0]);
    expect(allocateLargestRemainder(7, [0, 7])).toEqual([0, 7]);
    expect(() => allocateLargestRemainder(1, [0, 0])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(8, [0, 7])).toThrow(RangeError);
    for (const amount of [-1, 0.5, Number.NaN, 2 ** 53])
      expect(() => allocateLargestRemainder(amount, [1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1, [1.5])).toThrow(RangeError);
  });
  it("does not lose precision where the product exceeds 2^53", () => {
    const weights = [333_333_333_333, 333_333_333_333, 333_333_333_334];
    const parts = allocateLargestRemainder(999_999_999_999, weights);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(999_999_999_999);
    expect(parts).toEqual([333_333_333_333, 333_333_333_333, 333_333_333_333]);
  });
});
describe("order pricing", () => {
  it("prices an order without a discount", () => {
    expect(
      priceOrder({ lines: [line(1, 4500, 2), line(2, 12999)], deliveryFeeFils: 1500 }),
    ).toEqual({
      lines: [
        { ...line(1, 4500, 2), subtotalFils: 9000, discountFils: 0, totalFils: 9000 },
        { ...line(2, 12999), subtotalFils: 12999, discountFils: 0, totalFils: 12999 },
      ],
      merchandiseSubtotalFils: 21999,
      discountFils: 0,
      deliveryFeeFils: 1500,
      totalFils: 23499,
    });
  });
  it("discounts merchandise only, once per order, and shares it across lines", () => {
    // 15 % of AED 219.99 is 32.9985: half-up to 33.00. Delivery is not discounted.
    const priced = priceOrder({
      lines: [line(1, 4500, 2), line(2, 12999)],
      discountBasisPoints: 1500,
      deliveryFeeFils: 1500,
    });
    expect(priced).toMatchObject({
      merchandiseSubtotalFils: 21999,
      discountFils: 3300,
      totalFils: 20199,
    });
    // Exact shares 1350.06 and 1949.94.
    expect(priced.lines.map((item) => item.discountFils)).toEqual([1350, 1950]);
    expect(priced.lines.map((item) => item.totalFils)).toEqual([7650, 11049]);
  });
  it("rounds half-up", () => {
    const discount = (unit: number, basisPoints: number) =>
      priceOrder({ lines: [line(1, unit)], discountBasisPoints: basisPoints, deliveryFeeFils: 0 })
        .discountFils;
    expect(discount(30, 1500)).toBe(5); // 4.5
    expect(discount(10, 2500)).toBe(3); // 2.5
    expect(discount(333, 1500)).toBe(50); // 49.95
    expect(discount(329, 1500)).toBe(49); // 49.35
    expect(discount(1, 5000)).toBe(1); // 0.5
    expect(discount(1, 4999)).toBe(0); // 0.4999
    expect(discount(999, 1)).toBe(0); // 0.0999
  });
  it("charges only delivery at 100 % and never goes below zero", () => {
    const priced = priceOrder({
      lines: [line(1, 4500, 3), line(2, 1)],
      discountBasisPoints: 10_000,
      deliveryFeeFils: 2000,
    });
    expect(priced).toMatchObject({ discountFils: 13501, totalFils: 2000 });
    expect(priced.lines.map((item) => item.totalFils)).toEqual([0, 0]);
  });
  it("stays exact at the largest order the caps allow", () => {
    const lines = Array.from({ length: ORDER_LIMITS.maxLines }, (_, n) =>
      line(n, MAX_UNIT_PRICE_FILS, ORDER_LIMITS.maxLineQuantity),
    );
    const priced = priceOrder({ lines, discountBasisPoints: 3333, deliveryFeeFils: 1_000_000_000 });
    expect(priced.merchandiseSubtotalFils).toBe(500_000_000_000);
    expect(priced.discountFils).toBe(166_650_000_000);
    expect(priced.totalFils).toBe(334_350_000_000);
    expect(Number.isSafeInteger(priced.totalFils)).toBe(true);
  });
  it("keeps its invariants over many generated orders", () => {
    // Fixed-seed generator: the same orders on every run.
    let seed = 20261012;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let run = 0; run < 2000; run++) {
      const lines = Array.from({ length: 1 + next(8) }, (_, n) =>
        line(n, 1 + next(run % 3 === 0 ? 7 : 50_000), 1 + next(10)),
      );
      const input = { lines, discountBasisPoints: next(10_001), deliveryFeeFils: next(5000) };
      const priced = priceOrder(input);
      const sum = (pick: (item: (typeof priced.lines)[number]) => number) =>
        priced.lines.reduce((total, item) => total + pick(item), 0);
      expect(sum((item) => item.subtotalFils)).toBe(priced.merchandiseSubtotalFils);
      expect(sum((item) => item.discountFils)).toBe(priced.discountFils);
      expect(priced.totalFils).toBe(sum((item) => item.totalFils) + priced.deliveryFeeFils);
      for (const item of priced.lines) {
        expect(Number.isSafeInteger(item.discountFils)).toBe(true);
        expect(item.discountFils).toBeGreaterThanOrEqual(0);
        expect(item.discountFils).toBeLessThanOrEqual(item.subtotalFils);
      }
      // The same input always gives the same result.
      expect(priceOrder(input)).toEqual(priced);
    }
  });
  it("refuses floats, zero prices, unmerged lines and out-of-range input", () => {
    const base = { lines: [line(1, 100)], deliveryFeeFils: 0 };
    for (const bad of [
      { ...base, lines: [] },
      { ...base, lines: Array.from({ length: 51 }, (_, n) => line(n, 100)) },
      { ...base, lines: [line(1, 100), line(1, 100)] },
      { ...base, lines: [line(1, 0)] },
      { ...base, lines: [line(1, -100)] },
      { ...base, lines: [line(1, 99.5)] },
      { ...base, lines: [line(1, MAX_UNIT_PRICE_FILS + 1)] },
      { ...base, lines: [line(1, 100, 0)] },
      { ...base, lines: [line(1, 100, 11)] },
      { ...base, lines: [line(1, 100, 1.5)] },
      { ...base, lines: [line(1, Number.NaN)] },
      { ...base, discountBasisPoints: -1 },
      { ...base, discountBasisPoints: 10_001 },
      { ...base, discountBasisPoints: 15.5 },
      { ...base, deliveryFeeFils: -1 },
      { ...base, deliveryFeeFils: 12.5 },
      { ...base, deliveryFeeFils: Number.POSITIVE_INFINITY },
    ])
      expect(() => priceOrder(bad), JSON.stringify(bad).slice(0, 80)).toThrow(RangeError);
  });
});
