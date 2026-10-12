import { describe, expect, it } from "vitest";
import {
  couponDiscount,
  couponRejection,
  couponStatus,
  InvalidCouponCodeError,
  normalizeCouponCode,
  type CouponTerms,
} from "./coupon";
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-12T08:00:00.000Z");
const coupon = (changes: Partial<CouponTerms> = {}): CouponTerms => ({
  percentBps: 1000,
  minSubtotalFils: 0,
  startsAt: null,
  expiresAt: null,
  active: true,
  usageLimit: null,
  activeRedemptions: 0,
  ...changes,
});
describe("coupon codes", () => {
  it("compares in upper case without surrounding space", () => {
    for (const typed of ["welcome10", " Welcome10 ", "WELCOME10"])
      expect(normalizeCouponCode(typed)).toBe("WELCOME10");
    expect(normalizeCouponCode("eid_2026-a")).toBe("EID_2026-A");
  });
  it("refuses anything that is not one plain code", () => {
    for (const typed of [
      "",
      "AB",
      "A".repeat(33),
      "TWO CODES",
      "A,B,C",
      "-LEADING",
      "ｗｅｌｃｏｍｅ", // full-width letters
      "save10%",
      "x".repeat(65),
    ])
      expect(() => normalizeCouponCode(typed), typed).toThrow(InvalidCouponCodeError);
    expect(() => normalizeCouponCode(["A1B", "C2D"] as never)).toThrow(InvalidCouponCodeError);
  });
});
describe("coupon eligibility", () => {
  it("accepts an active coupon inside its window and limits", () => {
    expect(couponRejection(coupon(), NOW, 1)).toBeNull();
    expect(
      couponRejection(
        coupon({
          startsAt: NOW,
          expiresAt: at("2026-10-12T08:00:00.001Z"),
          minSubtotalFils: 10000,
          usageLimit: 5,
          activeRedemptions: 4,
        }),
        NOW,
        10000,
      ),
    ).toBeNull();
  });
  it("gives one reason, in a fixed order", () => {
    expect(couponRejection(null, NOW, 100)).toBe("UNKNOWN");
    expect(couponRejection(coupon({ active: false, expiresAt: at("2020-01-01") }), NOW, 100)).toBe(
      "INACTIVE",
    );
    expect(couponRejection(coupon({ startsAt: at("2026-10-12T08:00:00.001Z") }), NOW, 100)).toBe(
      "NOT_STARTED",
    );
    // Expiry is exclusive: at the expiry instant the coupon is over.
    expect(couponRejection(coupon({ expiresAt: NOW }), NOW, 100)).toBe("EXPIRED");
    expect(couponRejection(coupon({ expiresAt: at("2026-10-12T07:59:59.999Z") }), NOW, 100)).toBe(
      "EXPIRED",
    );
    expect(couponRejection(coupon({ minSubtotalFils: 10000 }), NOW, 9999)).toBe("MINIMUM_NOT_MET");
    expect(couponRejection(coupon({ usageLimit: 5, activeRedemptions: 5 }), NOW, 100)).toBe(
      "LIMIT_REACHED",
    );
    expect(
      couponRejection(
        coupon({ minSubtotalFils: 10000, usageLimit: 1, activeRedemptions: 1 }),
        NOW,
        1,
      ),
    ).toBe("MINIMUM_NOT_MET");
    expect(() => couponRejection(coupon(), NOW, 99.5)).toThrow(RangeError);
  });
  it("tests the minimum on the subtotal before the discount", () => {
    // AED 100.00 with 50 % off still meets a AED 100.00 minimum.
    const half = coupon({ percentBps: 5000, minSubtotalFils: 10000 });
    expect(couponRejection(half, NOW, 10000)).toBeNull();
    expect(couponDiscount(10000, half.percentBps)).toBe(5000);
  });
  it("computes the discount half-up and bounds the percentage", () => {
    expect(couponDiscount(21999, 1500)).toBe(3300);
    expect(couponDiscount(30, 1500)).toBe(5);
    expect(couponDiscount(1, 10000)).toBe(1);
    for (const bps of [0, -1, 10001, 15.5])
      expect(() => couponDiscount(100, bps)).toThrow(RangeError);
  });
});
describe("coupon status", () => {
  it("names the state the Owner sees", () => {
    expect(couponStatus(coupon(), NOW, false)).toBe("live");
    expect(couponStatus(coupon({ minSubtotalFils: 99999 }), NOW, false)).toBe("live");
    expect(couponStatus(coupon({ active: false }), NOW, false)).toBe("inactive");
    expect(couponStatus(coupon({ active: false }), NOW, true)).toBe("trashed");
    expect(couponStatus(coupon({ startsAt: at("2027-01-01") }), NOW, false)).toBe("scheduled");
    expect(couponStatus(coupon({ expiresAt: NOW }), NOW, false)).toBe("expired");
    expect(couponStatus(coupon({ usageLimit: 2, activeRedemptions: 2 }), NOW, false)).toBe(
      "used_up",
    );
  });
});
