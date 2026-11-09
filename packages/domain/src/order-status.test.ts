import { describe, expect, it } from "vitest";
import {
  COD_STATUSES,
  ORDER_SOURCES,
  PAYMENT_METHODS,
  ORDER_STATUSES,
  canTransition,
  formatOrderNumber,
  isTrackableOrderNumber,
  initialStatuses,
  isEditable,
  isPostHandoffCancellation,
  isTerminal,
  parseOrderNumber,
  RANDOM_ORDER_NUMBER,
} from "./order-status";

describe("order state machine", () => {
  it("follows the forward path", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "processing")).toBe(true);
    expect(canTransition("processing", "out_for_delivery")).toBe(true);
    expect(canTransition("out_for_delivery", "delivered")).toBe(true);
  });

  it("rejects skips and backwards moves", () => {
    expect(canTransition("pending", "delivered")).toBe(false);
    expect(canTransition("processing", "confirmed")).toBe(false);
  });

  it("never cancels a delivered order", () => {
    expect(canTransition("delivered", "cancelled")).toBe(false);
    expect(isTerminal("delivered")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("flags post-handoff cancellation", () => {
    expect(isPostHandoffCancellation("out_for_delivery", "cancelled")).toBe(true);
    expect(isPostHandoffCancellation("processing", "cancelled")).toBe(false);
  });

  it("has exactly six states", () => {
    expect(ORDER_STATUSES).toHaveLength(6);
  });
});

describe("order numbers, sources and cash status", () => {
  it("formats and reads back the display number", () => {
    expect(formatOrderNumber(1001)).toBe("IH-001001");
    expect(formatOrderNumber(1234567n)).toBe("IH-1234567");
    for (const typed of ["IH-001001", "ih 1001", "#1001", " 1001 ", "ih-1001"])
      expect(parseOrderNumber(typed)).toBe(1001);
    for (const typed of ["", "IH-", "1000", "999", "IH-00A1", "1001 OR 1=1", "-1001", "1e4"])
      expect(parseOrderNumber(typed), typed).toBeNull();
    expect(formatOrderNumber("1042")).toBe("IH-001042");
    for (const bad of [1000, 1001.5, Number.NaN, "", "10x1", "-1001", "1e4"])
      expect(() => formatOrderNumber(bad), String(bad)).toThrow(RangeError);
    for (const n of [1001, 5000, 999999, 1000000])
      expect(parseOrderNumber(formatOrderNumber(n))).toBe(n);
  });
  it("reads a random order number however it is typed, and tracks only those (ADR 0104)", () => {
    expect(formatOrderNumber(482193057316)).toBe("IH-482193057316");
    for (const typed of [
      "IH-482193057316",
      "ih482193057316",
      "IH 4821 9305 7316",
      "4821-9305-7316",
      " #482193057316 ",
    ])
      expect(parseOrderNumber(typed), typed).toBe(482193057316);
    for (const typed of ["4821--", "-482193057316", "IH-4821 9305 731x", "4821\n9305"])
      expect(parseOrderNumber(typed), typed).toBeNull();
    expect(isTrackableOrderNumber(RANDOM_ORDER_NUMBER.min)).toBe(true);
    expect(isTrackableOrderNumber(RANDOM_ORDER_NUMBER.max)).toBe(true);
    for (const n of [1001, 99_999_999_999, 1_000_000_000_000, 482193057316.5])
      expect(isTrackableOrderNumber(n), String(n)).toBe(false);
  });
  it("lets only a staff-entered order start confirmed, and edits only early", () => {
    expect(initialStatuses("storefront")).toEqual(["pending"]);
    expect(initialStatuses("manual")).toEqual(["pending", "confirmed"]);
    expect(ORDER_STATUSES.filter(isEditable)).toEqual(["pending", "confirmed"]);
    expect(COD_STATUSES).toEqual(["pending", "collected", "not_collected"]);
    expect(ORDER_SOURCES).toEqual(["storefront", "manual"]);
    // The database CHECK (migration 20261109000100) names exactly these.
    expect(PAYMENT_METHODS).toEqual(["cash_on_delivery", "bank_transfer", "online_payment"]);
  });
});
