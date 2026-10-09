import { describe, expect, it } from "vitest";
import {
  EndpointLimiter,
  LocalRateLimiter,
  RateLimiterUnavailableError,
  type EndpointLimitPolicy,
  type RateLimiter,
} from "./rate-limit";

const SECRET = "k".repeat(32);
const rule = { limit: 3, windowMs: 60_000 };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const broken: RateLimiter = {
  consume: () => Promise.reject(new Error("ECONNREFUSED")),
  reset: () => Promise.reject(new Error("ECONNREFUSED")),
};

describe("LocalRateLimiter", () => {
  it("admits up to the limit per window and reports when to retry", async () => {
    const time = clock();
    const limiter = new LocalRateLimiter({ maxKeys: 10, now: time.now });
    for (let i = 0; i < 3; i++) expect((await limiter.consume("a", rule)).allowed).toBe(true);
    expect(await limiter.consume("a", rule)).toEqual({ allowed: false, retryAfterMs: 60_000 });
    time.advance(59_999);
    expect((await limiter.consume("a", rule)).allowed).toBe(false);
    time.advance(1);
    expect((await limiter.consume("a", rule)).allowed).toBe(true);
    expect((await limiter.consume("b", rule)).allowed).toBe(true);
  });

  it("caps keys per partition and sends new keys to one shared overflow ceiling", async () => {
    const time = clock();
    const limiter = new LocalRateLimiter({ maxKeys: 2, now: time.now });
    const one = { limit: 1, windowMs: 60_000 };
    expect((await limiter.consume("login:identity:a", one)).allowed).toBe(true);
    expect((await limiter.consume("login:identity:b", one)).allowed).toBe(true);
    // Partition full: c and d share one overflow window (limit 1), live windows are never evicted.
    expect((await limiter.consume("login:identity:c", one)).allowed).toBe(true);
    expect(await limiter.consume("login:identity:d", one)).toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });
    expect(limiter.size).toBe(2);
    expect((await limiter.consume("login:identity:a", one)).allowed).toBe(false);
    // Another partition is unaffected by the flood.
    expect((await limiter.consume("login:ip:x", one)).allowed).toBe(true);
    // Expired windows free their slots.
    time.advance(60_000);
    expect((await limiter.consume("login:identity:d", one)).allowed).toBe(true);
    expect((await limiter.consume("login:identity:e", one)).allowed).toBe(true);
  });

  it("stays fast at the cap", async () => {
    const limiter = new LocalRateLimiter({ maxKeys: 50_000 });
    for (let i = 0; i < 50_000; i++) await limiter.consume(`login:identity:${i}`, rule);
    const started = performance.now();
    for (let i = 0; i < 5_000; i++) await limiter.consume(`login:identity:x${i}`, rule);
    expect(performance.now() - started).toBeLessThan(500);
    expect(limiter.size).toBe(50_000);
  });

  it("cleans up expired windows as time passes", async () => {
    const time = clock();
    const limiter = new LocalRateLimiter({ maxKeys: 100, now: time.now });
    for (let i = 0; i < 50; i++) await limiter.consume(`p:d:k${i}`, { limit: 1, windowMs: 1000 });
    time.advance(2000);
    await limiter.consume("p:d:k0", rule);
    await limiter.consume("p:d:k1", rule);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it("resets a key", async () => {
    const limiter = new LocalRateLimiter({ maxKeys: 10 });
    for (let i = 0; i < 4; i++) await limiter.consume("a", rule);
    await limiter.reset("a");
    expect((await limiter.consume("a", rule)).allowed).toBe(true);
  });
});

const login: EndpointLimitPolicy<"ip" | "identity"> = {
  endpoint: "login",
  rules: { ip: { limit: 5, windowMs: 60_000 }, identity: { limit: 2, windowMs: 60_000 } },
  outage: "fail_closed",
};
const checkout: EndpointLimitPolicy<"ip" | "phone"> = {
  endpoint: "checkout",
  rules: { ip: { limit: 10, windowMs: 60_000 }, phone: { limit: 5, windowMs: 60_000 } },
  outage: {
    fallback: { ip: { limit: 5, windowMs: 60_000 }, phone: { limit: 2, windowMs: 60_000 } },
    processCeiling: { limit: 4, windowMs: 60_000 },
  },
};

describe("EndpointLimiter", () => {
  it("checks dimensions in order and names the one that denied", async () => {
    const local = new LocalRateLimiter({ maxKeys: 100 });
    const limiter = new EndpointLimiter({ primary: local, local, keySecret: SECRET });
    const values = { ip: "203.0.113.7", identity: "owner@iqoshaven.test" };
    expect((await limiter.consume(login, values)).allowed).toBe(true);
    expect((await limiter.consume(login, values)).allowed).toBe(true);
    const third = await limiter.consume(login, values);
    expect(third).toMatchObject({ allowed: false, deniedBy: "identity", degraded: false });
    // Another identity from the same IP: the IP budget was still consumed by the denied attempt.
    const other = { ip: "203.0.113.7", identity: "staff@iqoshaven.test" };
    expect((await limiter.consume(login, other)).allowed).toBe(true);
    expect((await limiter.consume(login, other)).allowed).toBe(true);
    expect(await limiter.consume(login, other)).toMatchObject({ allowed: false, deniedBy: "ip" });
    // A source denied by IP creates no further identity keys.
    const before = local.size;
    await limiter.consume(login, { ip: "203.0.113.7", identity: "new@iqoshaven.test" });
    expect(local.size).toBe(before);
  });

  it("reports a failed shared reset", async () => {
    const failures: string[] = [];
    const limiter = new EndpointLimiter({
      primary: broken,
      local: new LocalRateLimiter({ maxKeys: 10 }),
      keySecret: SECRET,
      onPrimaryFailure: (endpoint) => failures.push(endpoint),
    });
    await limiter.reset(login, "identity", "owner@iqoshaven.test");
    expect(failures).toEqual(["login"]);
  });

  it("uses purpose-specific keyed hashes and never raw values", () => {
    const limiter = new EndpointLimiter({ primary: broken, local: broken, keySecret: SECRET });
    const key = limiter.key("login", "identity", "owner@iqoshaven.test");
    expect(key).not.toContain("owner");
    expect(key).toMatch(/^login:identity:[A-Za-z0-9_-]{43}$/);
    expect(limiter.key("reset", "identity", "owner@iqoshaven.test")).not.toBe(
      key.replace("login", "reset"),
    );
    const other = new EndpointLimiter({
      primary: broken,
      local: broken,
      keySecret: "x".repeat(32),
    });
    expect(other.key("login", "identity", "owner@iqoshaven.test")).not.toBe(key);
    expect(
      () => new EndpointLimiter({ primary: broken, local: broken, keySecret: "short" }),
    ).toThrow();
  });

  it("fails closed for authentication when the shared limiter is down", async () => {
    const failures: string[] = [];
    const limiter = new EndpointLimiter({
      primary: broken,
      local: new LocalRateLimiter({ maxKeys: 100 }),
      keySecret: SECRET,
      onPrimaryFailure: (endpoint) => failures.push(endpoint),
    });
    await expect(limiter.consume(login, { ip: "1", identity: "a" })).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
    expect(failures).toEqual(["login"]);
  });

  it("falls back to bounded local limits for checkout, with a per-process ceiling", async () => {
    const limiter = new EndpointLimiter({
      primary: broken,
      local: new LocalRateLimiter({ maxKeys: 100 }),
      keySecret: SECRET,
    });
    // A legitimate bounded checkout still works while the shared limiter is down.
    const first = await limiter.consume(checkout, { ip: "203.0.113.1", phone: "+971500000001" });
    expect(first).toEqual({ allowed: true, retryAfterMs: 0, degraded: true });
    // Phone fallback is 2/minute.
    await limiter.consume(checkout, { ip: "203.0.113.2", phone: "+971500000001" });
    expect(
      await limiter.consume(checkout, { ip: "203.0.113.3", phone: "+971500000001" }),
    ).toMatchObject({ allowed: false, deniedBy: "phone", degraded: true });
    // Fourth attempt overall hits the 4/minute per-process ceiling regardless of IP/phone.
    expect(
      await limiter.consume(checkout, { ip: "203.0.113.9", phone: "+971500000009" }),
    ).toMatchObject({ allowed: true });
    expect(
      await limiter.consume(checkout, { ip: "203.0.113.10", phone: "+971500000010" }),
    ).toMatchObject({ allowed: false, deniedBy: "process", degraded: true });
  });

  it("resets one dimension without touching the others", async () => {
    const local = new LocalRateLimiter({ maxKeys: 100 });
    const limiter = new EndpointLimiter({ primary: local, local, keySecret: SECRET });
    const values = { ip: "203.0.113.7", identity: "owner@iqoshaven.test" };
    await limiter.consume(login, values);
    await limiter.consume(login, values);
    await limiter.reset(login, "identity", values.identity);
    expect((await limiter.consume(login, values)).allowed).toBe(true);
    await limiter.consume(login, values);
    await limiter.consume(login, values);
    // IP budget (5) is now spent even though identity was reset.
    expect(await limiter.consume(login, { ...values, identity: "x" })).toMatchObject({
      allowed: false,
      deniedBy: "ip",
    });
  });
});
