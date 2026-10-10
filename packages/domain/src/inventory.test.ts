import { describe, expect, it } from "vitest";
import { crossedIntoLowStock, isLowStock } from "./inventory";

const level = (stock: number, threshold: number) => ({ stock, threshold });

describe("low-stock transitions", () => {
  it("is low at or below the threshold, including zero with no threshold", () => {
    expect(isLowStock(level(4, 3))).toBe(false);
    expect(isLowStock(level(3, 3))).toBe(true);
    expect(isLowStock(level(0, 0))).toBe(true);
    expect(isLowStock(level(1, 0))).toBe(false);
  });

  it.each([
    ["above → at", level(4, 3), level(3, 3), true],
    ["above → below in one step", level(10, 3), level(0, 3), true],
    ["last unit sold with threshold 0", level(1, 0), level(0, 0), true],
    ["above → still above", level(10, 3), level(4, 3), false],
    ["already low → lower", level(3, 3), level(1, 3), false],
    ["already low → zero", level(2, 3), level(0, 3), false],
    ["low → partial restock, still low", level(1, 3), level(3, 3), false],
    ["low → restocked above (re-arm, no alert)", level(1, 3), level(9, 3), false],
    ["new variant receives first stock", level(0, 0), level(20, 0), false],
  ])("stock change: %s", (_name, before, after, crossed) => {
    expect(crossedIntoLowStock(before, after)).toBe(crossed);
  });

  it.each([
    ["threshold raised over the stock", level(5, 3), level(5, 5), true],
    ["threshold raised again while low", level(5, 5), level(5, 8), false],
    ["threshold lowered while low, still low", level(2, 5), level(2, 3), false],
    ["threshold lowered below the stock (re-arm)", level(5, 8), level(5, 2), false],
    ["threshold raised, stock still above", level(9, 3), level(9, 5), false],
  ])("threshold change: %s", (_name, before, after, crossed) => {
    expect(crossedIntoLowStock(before, after)).toBe(crossed);
  });

  it("emits once per excursion: low, re-arm above, low again", () => {
    const stocks = [10, 3, 2, 0, 2, 3, 4, 3, 1];
    const crossings = stocks
      .slice(1)
      .map((stock, index) => crossedIntoLowStock(level(stocks[index]!, 3), level(stock, 3)));
    expect(crossings).toEqual([true, false, false, false, false, false, true, false]);
  });
});
