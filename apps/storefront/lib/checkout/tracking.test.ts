import type { OrderTrackingResponse } from "@ih/contracts";
import { describe, expect, it } from "vitest";
import { areaText, trackingView, trackSteps } from "./tracking";

const order = (changes: Partial<OrderTrackingResponse> = {}): OrderTrackingResponse => ({
  orderNumber: "IH-482193057316",
  placedAt: "2026-11-03T08:00:00.000Z",
  status: "confirmed",
  timeline: [
    { status: "pending", at: "2026-11-03T08:00:00.000Z" },
    { status: "confirmed", at: "2026-11-03T09:00:00.000Z" },
  ],
  merchandiseSubtotalFils: 24000,
  discountFils: 0,
  deliveryFeeFils: 1500,
  totalFils: 25500,
  etaText: "Same day",
  area: { name: "Dubai Marina", emirate: "dubai" },
  items: [
    { name: "TEREA UAE", attributes: {}, quantity: 2, unitPriceFils: 12000, totalFils: 24000 },
  ],
  ...changes,
});

describe("order tracking (ADR 0104)", () => {
  it("reads each answer as one thing to show", () => {
    expect(trackingView(200, order())).toEqual({ kind: "shown", order: order() });
    expect(trackingView(200, { ...order(), customerName: "x" })).toEqual({ kind: "failed" });
    expect(trackingView(404, null)).toEqual({ kind: "missing" });
    expect(trackingView(400, null)).toEqual({ kind: "missing" });
    expect(trackingView(429, null)).toEqual({ kind: "limited" });
    expect(trackingView(500, null)).toEqual({ kind: "failed" });
  });
  it("marks the steps reached, the current one, and when each was reached", () => {
    const steps = trackSteps(order());
    expect(steps.map((step) => [step.status, step.done, step.current])).toEqual([
      ["pending", true, false],
      ["confirmed", true, true],
      ["processing", false, false],
      ["out_for_delivery", false, false],
      ["delivered", false, false],
    ]);
    expect(steps[1]!.at).toBe("2026-11-03T09:00:00.000Z");
    // A staff-entered order can start confirmed: the first step is still done.
    const manual = trackSteps(
      order({ timeline: [{ status: "confirmed", at: "2026-11-03T09:00:00.000Z" }] }),
    );
    expect(manual[0]).toMatchObject({ done: true, at: null });
    // A cancelled order keeps the steps it reached before it was cancelled.
    const cancelled = trackSteps(
      order({
        status: "cancelled",
        timeline: [...order().timeline, { status: "cancelled", at: "2026-11-03T10:00:00.000Z" }],
      }),
    );
    expect(cancelled.filter((step) => step.done).map((step) => step.status)).toEqual([
      "pending",
      "confirmed",
    ]);
    expect(areaText(order().area)).toBe("Dubai Marina, Dubai");
  });
});
