import { describe, expect, it, vi } from "vitest";
import { createPool } from "./client";
describe("database background errors", () => {
  it("handles idle connection errors without an unhandled emitter exception", async () => {
    const observed = vi.fn();
    const pool = createPool({
      connectionString: "postgres://unused:unused@127.0.0.1:1/unused",
      applicationName: "test",
      onBackgroundError: observed,
    });
    const error = new Error("sensitive connection details");
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(observed).toHaveBeenCalledWith(error);
    await pool.end();
  });
});
