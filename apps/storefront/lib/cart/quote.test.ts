import type { StoreQuoteResponse } from "@ih/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptedFrom,
  canProceed,
  compareQuotes,
  dropsCoupon,
  QUOTE_MESSAGES,
  quoteProblem,
  requestKey,
} from "./quote";
const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";
const AREA = "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a35";
const request = (changes = {}) => ({
  lines: [
    { variantId: A, quantity: 2 },
    { variantId: B, quantity: 1 },
  ],
  areaId: AREA,
  couponCode: null as string | null,
  ...changes,
});
const quote = (fingerprint: string, totalFils: number, changes = {}) =>
  ({
    totalFils,
    insufficientStock: [],
    quote: { fingerprint, token: "token-" + fingerprint, expiresAt: "2026-10-12T08:15:00.000Z" },
    ...changes,
  }) as unknown as StoreQuoteResponse;
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
describe("quote request key", () => {
  it("is the same for the same cart however it is ordered or typed", () => {
    const key = requestKey(request());
    expect(requestKey(request({ lines: [...request().lines].reverse() }))).toBe(key);
    expect(requestKey(request({ areaId: AREA.toUpperCase() }))).toBe(key);
    expect(requestKey(request({ couponCode: " " }))).toBe(key);
    expect(requestKey(request({ couponCode: "eid10" }))).toBe(
      requestKey(request({ couponCode: " EID10 " })),
    );
  });
  it("differs when the shopper changes anything", () => {
    const key = requestKey(request());
    for (const changed of [
      request({ lines: [{ variantId: A, quantity: 3 }, request().lines[1]] }),
      request({ lines: [request().lines[0]] }),
      request({ areaId: "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a36" }),
      request({ couponCode: "EID10" }),
    ])
      expect(requestKey(changed as ReturnType<typeof request>)).not.toBe(key);
  });
});
describe("accepting a quote", () => {
  const key = requestKey(request());
  const accepted = acceptedFrom(key, quote("fp1", 20199));
  it("needs explicit acceptance only when the same cart costs something else", () => {
    expect(compareQuotes(null, key, quote("fp1", 20199))).toBe("first");
    expect(compareQuotes(accepted, key, quote("fp1", 20199))).toBe("same");
    expect(compareQuotes(accepted, key, quote("fp2", 20699))).toBe("changed");
    // Cheaper is still a change the shopper is shown.
    expect(compareQuotes(accepted, key, quote("fp3", 19000))).toBe("changed");
    // The shopper changed the cart: the new total answers their own action.
    expect(
      compareQuotes(accepted, requestKey(request({ couponCode: "EID10" })), quote("fp4", 18000)),
    ).toBe("first");
  });
  it("does not accept a higher total on its own when the server drops an accepted code", () => {
    const withCode = requestKey(request({ couponCode: "EID10" }));
    const acceptedWithCode = acceptedFrom(withCode, quote("fp1", 18000));
    // The code ran out; the cart is priced again without it (a different request key).
    expect(compareQuotes(acceptedWithCode, key, quote("fp2", 20199), acceptedWithCode)).toBe(
      "changed",
    );
    // A code the shopper just typed and never had accepted: nothing to protect.
    expect(compareQuotes(accepted, key, quote("fp1", 20199), null)).toBe("same");
    expect(compareQuotes(null, key, quote("fp1", 20199), null)).toBe("first");
    // The same total without the code needs no second look.
    expect(compareQuotes(acceptedWithCode, key, quote("fp2", 18000), acceptedWithCode)).toBe(
      "first",
    );
  });
  it("lets the shopper proceed only with an accepted, current, fillable quote", () => {
    expect(canProceed(accepted, key, quote("fp1", 20199), NOW)).toBe(true);
    expect(canProceed(null, key, quote("fp1", 20199), NOW)).toBe(false);
    expect(canProceed(accepted, key, null, NOW)).toBe(false);
    expect(canProceed(accepted, key, quote("fp2", 20699), NOW)).toBe(false);
    expect(
      canProceed(accepted, requestKey(request({ couponCode: "X10" })), quote("fp1", 20199), NOW),
    ).toBe(false);
    expect(canProceed(accepted, key, quote("fp1", 20199, { insufficientStock: [A] }), NOW)).toBe(
      false,
    );
    expect(canProceed(accepted, key, quote("fp1", 20199), Date.parse(accepted.expiresAt))).toBe(
      false,
    );
  });
});
describe("quote problems", () => {
  it("maps API answers to one message each", () => {
    expect(quoteProblem(409, "AREA_UNAVAILABLE")).toBe("AREA_UNAVAILABLE");
    expect(quoteProblem(409, "VARIANT_UNAVAILABLE")).toBe("VARIANT_UNAVAILABLE");
    expect(quoteProblem(409, "COUPON_INVALID")).toBe("COUPON_INVALID");
    expect(quoteProblem(409, "COUPON_LIMIT_REACHED")).toBe("COUPON_LIMIT_REACHED");
    expect(quoteProblem(429, undefined)).toBe("RATE_LIMITED");
    expect(quoteProblem(403, "AGE_VERIFICATION_REQUIRED")).toBe("AGE");
    for (const [status, code] of [
      [409, "CONFLICT"],
      [409, undefined],
      [400, "BAD_REQUEST"],
      [500, undefined],
      [503, "X"],
    ] as const)
      expect(quoteProblem(status, code)).toBe("FAILED");
    for (const message of Object.values(QUOTE_MESSAGES)) expect(message.length).toBeGreaterThan(10);
  });
  it("drops only a refused coupon", () => {
    expect(dropsCoupon("COUPON_INVALID")).toBe(true);
    expect(dropsCoupon("COUPON_LIMIT_REACHED")).toBe(true);
    for (const other of [
      "AREA_UNAVAILABLE",
      "VARIANT_UNAVAILABLE",
      "RATE_LIMITED",
      "AGE",
      "FAILED",
    ] as const)
      expect(dropsCoupon(other)).toBe(false);
  });
});
