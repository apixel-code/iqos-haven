import { describe, expect, it } from "vitest";
import { bounded, handleSystemJob } from "./lifecycle";
describe("worker foundation safety", () => {
  it("refuses unimplemented jobs rather than acknowledging business effects", async () => {
    await expect(handleSystemJob({ name: "order.created" })).rejects.toThrow("Unsupported");
    await expect(handleSystemJob({ name: "healthcheck" })).resolves.toEqual({ ok: true });
  });
  it("bounds startup dependency waits", async () => {
    await expect(bounded(new Promise<never>(() => {}), 10)).rejects.toThrow("timed out");
    await expect(bounded(Promise.resolve(1), 10)).resolves.toBe(1);
  });
});
