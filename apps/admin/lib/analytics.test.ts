import { describe, expect, it } from "vitest";
import { analyticsRange, changeBps, percent, rangeDays, signedChange } from "./analytics";

describe("analytics display helpers", () => {
  it("counts ranges in Dubai days, today included", () => {
    // 21:30 UTC is already the next day in Dubai.
    expect(analyticsRange(7, new Date("2026-10-15T21:30:00Z"))).toEqual({
      from: "2026-10-10",
      to: "2026-10-16",
      preset: 7,
    });
    expect(analyticsRange(1, new Date("2026-03-01T00:00:00Z")).from).toBe("2026-03-01");
  });

  it("shows basis points as a percentage rounded half-up to a tenth", () => {
    expect(percent(1234)).toBe("12.3%");
    expect(percent(1235)).toBe("12.4%");
    expect(percent(0)).toBe("0.0%");
    expect(percent(10_000)).toBe("100.0%");
    expect(percent(null)).toBe("—");
  });

  it("compares with the previous period without dividing by zero", () => {
    const plain = (n: number) => String(n);
    expect(signedChange(120, 100, plain)).toBe("+20.0% vs previous period");
    expect(signedChange(75, 100, plain)).toBe("−25.0% vs previous period");
    expect(signedChange(5, 0, plain)).toBe("Previous period: 0");
    expect(signedChange(0, 0, plain)).toBe("Same as previous period");
    expect(signedChange(null, 100, plain)).toBe("No comparison");
  });

  it("lists every day of a range across month ends", () => {
    expect(rangeDays("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(rangeDays("2026-10-02", "2026-10-01")).toEqual([]);
  });
});

describe("change against the previous period (V-A10)", () => {
  it("is basis points of the earlier figure, or null with nothing to compare", () => {
    expect(changeBps(1500, 1000)).toBe(5000);
    expect(changeBps(900, 1000)).toBe(-1000);
    expect(changeBps(1000, 1000)).toBe(0);
    expect(changeBps(5, 0)).toBeNull();
    expect(changeBps(null, 10)).toBeNull();
    expect(changeBps(10, null)).toBeNull();
  });
});
