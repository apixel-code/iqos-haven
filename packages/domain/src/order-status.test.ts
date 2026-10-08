import { describe, expect, it } from "vitest";
import {
  ORDER_STATUSES,
  canTransition,
  isPostHandoffCancellation,
  isTerminal,
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
