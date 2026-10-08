import { describe, expect, it } from "vitest";
import { dubaiDaily, dueSlots } from "./schedule";

describe("schedule slots", () => {
  it("places the 09:00 Asia/Dubai daily slot at 05:00 UTC", () => {
    const before = dueSlots(dubaiDaily(9), new Date("2026-10-08T04:59:59Z"), 1);
    const after = dueSlots(dubaiDaily(9), new Date("2026-10-08T05:00:00Z"), 1);
    expect(before.map((d) => d.toISOString())).toEqual(["2026-10-07T05:00:00.000Z"]);
    expect(after.map((d) => d.toISOString())).toEqual(["2026-10-08T05:00:00.000Z"]);
  });

  it("returns a bounded catch-up window, oldest first", () => {
    const slots = dueSlots(dubaiDaily(9), new Date("2026-10-08T12:00:00Z"), 3);
    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-10-06T05:00:00.000Z",
      "2026-10-07T05:00:00.000Z",
      "2026-10-08T05:00:00.000Z",
    ]);
  });

  it("handles a Dubai time that falls on the previous UTC day", () => {
    const slots = dueSlots(dubaiDaily(2, 30), new Date("2026-10-08T00:00:00Z"), 1);
    expect(slots[0]!.toISOString()).toBe("2026-10-07T22:30:00.000Z");
  });

  it("aligns interval slots to the epoch so replicas agree", () => {
    const spec = { kind: "interval", everyMs: 60_000 } as const;
    expect(
      dueSlots(spec, new Date("2026-10-08T10:00:59.900Z"), 2).map((d) => d.toISOString()),
    ).toEqual(["2026-10-08T09:59:00.000Z", "2026-10-08T10:00:00.000Z"]);
  });

  it("rejects invalid specs and catch-up windows", () => {
    expect(() => dueSlots({ kind: "interval", everyMs: 10 }, new Date(), 1)).toThrow(RangeError);
    expect(() => dueSlots(dubaiDaily(24), new Date(), 1)).toThrow(RangeError);
    expect(() => dueSlots(dubaiDaily(9), new Date(), 0)).toThrow(RangeError);
  });
});
