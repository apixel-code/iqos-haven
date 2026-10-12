import { describe, expect, it } from "vitest";
import {
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
    expect(deliveryForArea(config, area)).toEqual({ feeFils: 1250, etaText: config.etaText });
    expect(deliveryForArea({ ...config, flatFeeFils: 0 }, area).feeFils).toBe(0);
    expect(() => deliveryForArea({ ...config, flatFeeFils: 0.5 }, area)).toThrow(RangeError);
  });
});
