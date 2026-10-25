import { describe, expect, it } from "vitest";
import type { CouponResponse } from "@ih/contracts";
import {
  bpsToPercent,
  couponActiveCommand,
  couponCreateCommand,
  couponGroup,
  couponPreview,
  couponSentence,
  generateCouponCode,
  couponStatusLabel,
  couponUpdateCommand,
  isoToLocal,
  localToIso,
  percentToBps,
} from "./coupons";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
describe("coupon form values", () => {
  it("turns percentage text into basis points without floating point", () => {
    expect(percentToBps("15")).toBe(1500);
    expect(percentToBps(" 12.5 % ")).toBe(1250);
    expect(percentToBps("0.01")).toBe(1);
    expect(percentToBps("100")).toBe(10000);
    // 0.07 × 100 is 7.000000000000001 in floating point; from text it is exactly 7.
    expect(percentToBps("0.07")).toBe(7);
    for (const bad of ["", "0", "100.01", "101", "-5", "12.345", "ten", "1e2", "AED 20"])
      expect(() => percentToBps(bad), bad).toThrow();
    for (const bps of [1, 7, 50, 1250, 1500, 10000])
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    expect(bpsToPercent(1500)).toBe("15");
    expect(bpsToPercent(1250)).toBe("12.5");
    expect(bpsToPercent(1205)).toBe("12.05");
  });
  it("round-trips a local date and time", () => {
    expect(localToIso("")).toBeNull();
    expect(isoToLocal(null)).toBe("");
    expect(isoToLocal(localToIso("2026-11-01T09:30"))).toBe("2026-11-01T09:30");
    expect(() => localToIso("soon")).toThrow();
  });
  it("builds the create and update commands", () => {
    expect(
      couponCreateCommand(
        form({ code: " eid10 ", percent: "10", minimum: "99.50", usageLimit: "200", active: "on" }),
      ),
    ).toEqual({
      code: "EID10",
      percentBps: 1000,
      minSubtotalFils: 9950,
      startsAt: null,
      expiresAt: null,
      active: true,
      usageLimit: 200,
    });
    expect(couponUpdateCommand(4, form({ percent: "12.5" }))).toEqual({
      version: 4,
      percentBps: 1250,
      minSubtotalFils: 0,
      startsAt: null,
      expiresAt: null,
      active: false,
      usageLimit: null,
    });
    expect(() => couponCreateCommand(form({ code: "x", percent: "10" }))).toThrow();
    expect(() =>
      couponCreateCommand(form({ code: "EID10", percent: "10", usageLimit: "0" })),
    ).toThrow();
    expect(() =>
      couponUpdateCommand(
        1,
        form({ percent: "10", startsAt: "2026-11-02T00:00", expiresAt: "2026-11-01T00:00" }),
      ),
    ).toThrow();
  });
  it("describes a coupon in one sentence", () => {
    const coupon = {
      percentBps: 1250,
      minSubtotalFils: 10000,
      usageLimit: 50,
      activeRedemptions: 3,
    } as CouponResponse;
    expect(couponSentence(coupon)).toBe(
      "12.5% off products on orders of AED 100.00 or more of products. Delivery is not discounted. 3 of 50 used.",
    );
    expect(couponSentence({ ...coupon, minSubtotalFils: 0, usageLimit: null })).toBe(
      "12.5% off products on any order. Delivery is not discounted. 3 used, no limit.",
    );
    expect(couponStatusLabel("used_up")).toBe("Used up");
  });
});

describe("discounts screen (V-A9)", () => {
  const coupon = {
    version: 3,
    percentBps: 1250,
    minSubtotalFils: 10000,
    startsAt: null,
    expiresAt: "2026-11-30T19:59:59.000Z",
    active: true,
    usageLimit: 50,
  } as CouponResponse;
  it("groups statuses into the prototype's tabs", () => {
    expect(couponGroup("live")).toBe("active");
    expect(couponGroup("scheduled")).toBe("inactive");
    expect(couponGroup("inactive")).toBe("inactive");
    expect(couponGroup("used_up")).toBe("expired");
    expect(couponGroup("expired")).toBe("expired");
    expect(couponGroup("trashed")).toBeNull();
  });
  it("switches a coupon off without touching its terms", () => {
    expect(couponActiveCommand(coupon, false)).toEqual({
      version: 3,
      percentBps: 1250,
      minSubtotalFils: 10000,
      startsAt: null,
      expiresAt: "2026-11-30T19:59:59.000Z",
      active: false,
      usageLimit: 50,
    });
  });
  it("generates unambiguous 8-character codes", () => {
    const code = generateCouponCode(() => new Uint8Array([0, 1, 2, 30, 31, 62, 200, 255]));
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(generateCouponCode()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });
  it("previews the coupon as it is typed, with the saving rounded half-up in fils", () => {
    expect(
      couponPreview({ code: "weekend12", percent: "12.5", minimum: "99.99", ends: "30 Nov 2026" }),
    ).toBe(
      "WEEKEND12 gives 12.5% off orders of AED 99.99 or more of products until 30 Nov 2026. Delivery is not discounted. On an AED 99.99 order the customer saves AED 12.50 on products.",
    );
    expect(couponPreview({ code: "", percent: "10", minimum: "", ends: null })).toBe(
      "CODE gives 10% off any order. Delivery is not discounted.",
    );
    expect(couponPreview({ code: "X", percent: "", minimum: "", ends: null })).toBeNull();
  });
});
