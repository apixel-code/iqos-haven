import { describe, expect, it } from "vitest";
import { checkQueuePolicy } from "./queue-policy";

describe("checkQueuePolicy", () => {
  it("accepts noeviction", () => {
    expect(checkQueuePolicy("noeviction", "production")).toEqual({ ok: true });
  });
  it("is fatal outside development", () => {
    expect(checkQueuePolicy("allkeys-lru", "production")).toMatchObject({ ok: false, fatal: true });
    expect(checkQueuePolicy("allkeys-lru", "staging")).toMatchObject({ ok: false, fatal: true });
  });
  it("only warns in development", () => {
    expect(checkQueuePolicy("volatile-lru", "development")).toMatchObject({
      ok: false,
      fatal: false,
    });
  });
});
