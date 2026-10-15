import { describe, expect, it } from "vitest";
import { freeDeliveryProgress } from "./free-delivery";

describe("free-delivery progress (step 100)", () => {
  it("shows nothing while no threshold is switched on", () => {
    expect(freeDeliveryProgress(null, 0)).toBeNull();
    expect(freeDeliveryProgress(null, 999_999)).toBeNull();
    expect(freeDeliveryProgress(0, 100)).toBeNull();
  });
  it("words the server's amounts when a threshold exists", () => {
    expect(freeDeliveryProgress(15_000, 9_000)).toEqual({
      kind: "short",
      remainingFils: 6_000,
      percent: 60,
    });
    expect(freeDeliveryProgress(15_000, 15_000)).toEqual({ kind: "reached" });
  });
});
