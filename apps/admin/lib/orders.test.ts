import { describe, expect, it } from "vitest";
import { aedToFils, inputInstant, localInstant } from "./orders";

describe("cash amounts typed by staff", () => {
  it("reads AED as integer fils without float arithmetic", () => {
    expect(aedToFils("65")).toBe(6500);
    expect(aedToFils("65.5")).toBe(6550);
    expect(aedToFils(" 65.50 ")).toBe(6550);
    expect(aedToFils("0.07")).toBe(7);
    expect(aedToFils("1234567.89")).toBe(123456789);
    // 0.1 + 0.2 style inputs stay exact.
    expect(aedToFils("10.30")).toBe(1030);
  });

  it("refuses anything that is not a plain amount", () => {
    for (const text of [
      "",
      "-1",
      "65.555",
      "65,50",
      "AED 65",
      "1e3",
      ".5",
      "65.",
      "12345678901",
      " ",
      "0x10",
    ])
      expect(aedToFils(text)).toBeNull();
  });

  it("round-trips a date-time input to the minute", () => {
    expect(localInstant("")).toBeNull();
    expect(localInstant("not a date")).toBeNull();
    const iso = localInstant("2026-10-14T12:05")!;
    expect(inputInstant(iso)).toBe("2026-10-14T12:05");
  });
});
