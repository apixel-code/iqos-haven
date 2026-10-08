import { describe, expect, it } from "vitest";
import { checkQueuePolicy, memoryPressure, parseRedisInfo } from "./queue-policy";

const INFO = [
  "# Memory",
  "used_memory:850",
  "used_memory_human:850B",
  "maxmemory:1000",
  "maxmemory_policy:noeviction",
  "",
].join("\r\n");

describe("checkQueuePolicy", () => {
  it("accepts noeviction", () => {
    expect(checkQueuePolicy("noeviction", "production")).toEqual({ ok: true });
  });
  it("is fatal outside development, including an unreadable policy", () => {
    expect(checkQueuePolicy("allkeys-lru", "production")).toMatchObject({ ok: false, fatal: true });
    expect(checkQueuePolicy("allkeys-lru", "staging")).toMatchObject({ ok: false, fatal: true });
    expect(checkQueuePolicy(undefined, "production")).toMatchObject({ ok: false, fatal: true });
  });
  it("only warns in development", () => {
    expect(checkQueuePolicy("volatile-lru", "development")).toMatchObject({
      ok: false,
      fatal: false,
    });
  });
});

describe("INFO memory parsing", () => {
  it("reads policy and memory without CONFIG access", () => {
    expect(parseRedisInfo(INFO)).toEqual({
      policy: "noeviction",
      usedMemory: 850,
      maxMemory: 1000,
    });
    expect(memoryPressure(parseRedisInfo(INFO))).toBe(0.85);
  });
  it("treats missing or malformed fields as unknown", () => {
    expect(parseRedisInfo("# Memory\nused_memory:abc\n")).toEqual({
      policy: undefined,
      usedMemory: undefined,
      maxMemory: undefined,
    });
    expect(memoryPressure({ policy: "noeviction", usedMemory: 5, maxMemory: 0 })).toBeUndefined();
  });
});
