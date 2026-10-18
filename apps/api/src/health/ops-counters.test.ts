import { describe, expect, it } from "vitest";
import { OpsCounters } from "./ops-counters";

const minute = 60_000;
describe("checkout ops counters (step 125)", () => {
  it("counts watched routes over a sliding ten-minute window, 5xx as server errors", () => {
    const counters = new OpsCounters();
    const t0 = 1_000 * minute;
    counters.record("POST /v1/store/orders", 201, t0);
    counters.record("POST /v1/store/orders", 409, t0);
    counters.record("POST /v1/store/cart/quote", 500, t0 + minute);
    counters.record("GET /v1/store/products", 500, t0);
    expect(counters.snapshot(t0 + minute)).toEqual({
      requests: 3,
      serverErrors: 1,
      windowSeconds: 600,
    });
    // Ten minutes later the first minute has left the window.
    expect(counters.snapshot(t0 + 10 * minute)).toMatchObject({ requests: 1, serverErrors: 1 });
    expect(counters.snapshot(t0 + 11 * minute)).toMatchObject({ requests: 0, serverErrors: 0 });
  });

  it("ignores orders while checkout is closed", () => {
    const counters = new OpsCounters(false);
    counters.record("POST /v1/store/orders", 503, 0);
    counters.record("POST /v1/store/cart/quote", 200, 0);
    expect(counters.snapshot(0)).toMatchObject({ requests: 1, serverErrors: 0 });
  });
});
