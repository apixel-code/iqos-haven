import { describe, expect, it } from "vitest";
import {
  deliveryFeeFor,
  deliveryForArea,
  DeliveryUnavailableError,
  DeliveryUnconfiguredError,
  UAE_EMIRATES,
} from "./delivery";
const config = { flatFeeFils: 1250, etaText: "Approved test ETA", freeThresholdFils: null };
describe("UAE flat-fee selection", () => {
  it("rejects missing, inactive and non-UAE areas", () => {
    for (const area of [
      null,
      { active: false, emirate: "dubai" },
      { active: true, emirate: "muscat" },
      { active: true, emirate: "Dubai" },
    ])
      expect(() => deliveryForArea(config, area)).toThrow(DeliveryUnavailableError);
  });
  it("charges the same flat fee in every emirate", () => {
    for (const emirate of UAE_EMIRATES)
      expect(deliveryForArea(config, { active: true, emirate }).feeFils).toBe(1250);
    expect(UAE_EMIRATES).toHaveLength(7);
  });
  it("fails closed without approved fee/ETA", () => {
    expect(() => deliveryForArea(null, { active: true, emirate: "dubai" })).toThrow(
      DeliveryUnconfiguredError,
    );
  });
  it("uses the configured integer fee, including an explicit zero", () => {
    const area = { active: true, emirate: "dubai" };
    expect(deliveryForArea(config, area)).toEqual({
      feeFils: 1250,
      etaText: config.etaText,
      freeThresholdFils: null,
    });
    expect(deliveryForArea({ ...config, flatFeeFils: 0 }, area).feeFils).toBe(0);
    expect(() => deliveryForArea({ ...config, flatFeeFils: 0.5 }, area)).toThrow(RangeError);
  });
  it("waives the fee from the free-delivery threshold, after the discount (ADR 0113)", () => {
    const delivery = { feeFils: 2000, freeThresholdFils: 40000 };
    expect(deliveryFeeFor(delivery, 39999)).toBe(2000);
    expect(deliveryFeeFor(delivery, 40000)).toBe(0);
    expect(deliveryFeeFor(delivery, 125000)).toBe(0);
    expect(deliveryFeeFor({ feeFils: 2000, freeThresholdFils: null }, 999999)).toBe(2000);
    expect(() => deliveryFeeFor(delivery, 400.5)).toThrow(RangeError);
    const area = { active: true, emirate: "sharjah" };
    expect(deliveryForArea({ ...config, freeThresholdFils: 40000 }, area).freeThresholdFils).toBe(
      40000,
    );
  });
});
