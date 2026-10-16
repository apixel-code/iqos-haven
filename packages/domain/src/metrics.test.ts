import { describe, expect, it } from "vitest";
import {
  addDays,
  averageFils,
  daysBetween,
  dubaiDate,
  dubaiDayRange,
  MetricRangeError,
  rateBps,
} from "./metrics";

describe("financial metric definitions (step 105)", () => {
  it("bounds Dubai calendar days in UTC", () => {
    const one = dubaiDayRange("2026-10-15", "2026-10-15");
    expect(one.start.toISOString()).toBe("2026-10-14T20:00:00.000Z");
    expect(one.end.toISOString()).toBe("2026-10-15T20:00:00.000Z");
    expect(one.days).toBe(1);
    const year = dubaiDayRange("2028-01-01", "2028-12-31");
    expect(year.days).toBe(366);
  });

  it("refuses impossible, reversed and over-long ranges", () => {
    for (const [from, to] of [
      ["2026-02-30", "2026-03-01"],
      ["2026-10-16", "2026-10-15"],
      ["2026-1-5", "2026-01-06"],
      ["2025-01-01", "2026-01-02"],
    ])
      expect(() => dubaiDayRange(from!, to!)).toThrow(MetricRangeError);
  });

  it("averages to the fil, half-up, never with floats", () => {
    expect(averageFils(1000n, 3)).toBe(333);
    expect(averageFils(1001n, 2)).toBe(501); // 500.5 rounds up
    expect(averageFils(0n, 0)).toBeNull();
    expect(() => averageFils(2n ** 60n, 1)).toThrow(RangeError);
    expect(() => averageFils(-1n, 1)).toThrow(RangeError);
  });

  it("gives rates in basis points, half-up", () => {
    expect(rateBps(1, 3)).toBe(3333);
    expect(rateBps(2, 3)).toBe(6667);
    expect(rateBps(0, 5)).toBe(0);
    expect(rateBps(1, 0)).toBeNull();
  });

  it("names the Dubai day of an instant and steps whole days (step 107)", () => {
    expect(dubaiDate(new Date("2026-10-15T19:59:59Z"))).toBe("2026-10-15");
    expect(dubaiDate(new Date("2026-10-15T20:00:00Z"))).toBe("2026-10-16");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(() => addDays("2026-02-30", 1)).toThrow(MetricRangeError);
    expect(() => dubaiDate(new Date(NaN))).toThrow(MetricRangeError);
  });
});
