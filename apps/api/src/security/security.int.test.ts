import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  type ApiEnv,
} from "@ih/config";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher, RedisRateLimiter } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const QUEUE_REDIS_URL = process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379";
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-security-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const fast = { memoryKib: 19_456, timeCost: 2, parallelism: 1 };
const hasher = new Argon2PasswordHasher(fast);
const PASSWORD = "copper-lantern-river-71";
const ADMIN = "http://localhost:8081";
const STORE = "http://localhost:8080";

let env: ApiEnv;
let app: INestApplication;
let base: string;

const post = (
  path: string,
  options: { headers?: Record<string, string>; body?: string; ip?: string } = {},
) =>
  fetch(`${base}/v1/${path}`, {
    method: "POST",
    headers: { "x-ih-client-ip": options.ip ?? "198.51.100.1", ...options.headers },
    body: options.body,
  });
const login = (email: string, ip: string, password = PASSWORD) =>
  post("auth/login", {
    ip,
    headers: { origin: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
const envelope = async (response: Response) =>
  (await response.json()) as { error: { code: string; requestId: string; fields: unknown[] } };

describe("Origin/CSRF controls and sign-in limits (real app)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    env = apiEnvSchema.parse({
      NODE_ENV: "test",
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: DATABASE_TEST_URL,
      QUEUE_REDIS_URL,
      ARGON2_MEMORY_KIB: fast.memoryKib,
      ARGON2_TIME_COST: fast.timeCost,
      ARGON2_PARALLELISM: fast.parallelism,
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    for (const email of ["staff@iqoshaven.test", "other@iqoshaven.test", "reset@iqoshaven.test"])
      await db.staffUser.create({
        data: { email, name: "Test", roleId: role.id, passwordHash: await hasher.hash(PASSWORD) },
      });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses sign-in and sign-out without the admin Origin, before any handler runs", async () => {
    const body = JSON.stringify({ email: "staff@iqoshaven.test", password: PASSWORD });
    const cases: Array<Record<string, string>> = [
      { "content-type": "application/json" },
      { "content-type": "application/json", origin: "https://evil.example" },
      { "content-type": "application/json", origin: STORE },
      { "content-type": "application/json", origin: ADMIN, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of cases) {
      const response = await post("auth/login", { headers, body });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { error } = await envelope(response);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.requestId).toBe(response.headers.get("x-request-id"));
    }
    expect((await post("auth/logout")).status).toBe(403);
    expect((await post("auth/logout", { headers: { origin: ADMIN } })).status).toBe(204);
    expect(await db.session.count()).toBe(0);
  });

  it("refuses non-JSON bodies such as cross-site form posts", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const response = await post("auth/login", {
        headers: { origin: ADMIN, "content-type": type },
        body: "email=staff@iqoshaven.test&password=" + PASSWORD,
      });
      expect(response.status).toBe(415);
      expect((await envelope(response)).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect(await db.session.count()).toBe(0);
  });

  it("classifies encoded and doubled paths as the router does", async () => {
    const body = JSON.stringify({ email: "staff@iqoshaven.test", password: PASSWORD });
    for (const path of ["v1/%61uth/login", "v1//auth/login"]) {
      const response = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { origin: STORE, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(403);
    }
    expect(await db.session.count()).toBe(0);
  });

  it("ignores a client-IP header that is not an address", async () => {
    // Rotating junk values cannot mint fresh per-IP budgets: they all fall back to the peer.
    for (let i = 0; i < 30; i++)
      expect((await login(`junk${i}@iqoshaven.test`, `junk-${i}`)).status).toBe(401);
    expect((await login("junk@iqoshaven.test", "junk-x")).status).toBe(429);
  });

  it("leaves safe requests alone", async () => {
    const response = await fetch(`${base}/v1/auth/me`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(401);
    expect((await fetch(`${base}/v1/health/live`)).status).toBe(200);
  });

  it("limits failed sign-ins per identity and network with a generic 429", async () => {
    const ip = "198.51.100.20";
    for (let i = 0; i < 10; i++)
      expect((await login("staff@iqoshaven.test", ip, "wrong-password-entirely")).status).toBe(401);
    // Even the correct password is refused now: the limiter is not a password oracle.
    const limited = await login("staff@iqoshaven.test", ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(800);
    expect(limited.headers.get("set-cookie")).toBeNull();
    const { error } = await envelope(limited);
    expect(error.code).toBe("RATE_LIMITED");
    expect(JSON.stringify(error)).not.toContain("staff@");
    // The same account from another network, and another account from this IP, still work.
    expect((await login("staff@iqoshaven.test", "192.0.2.10")).status).toBe(200);
    expect((await login("other@iqoshaven.test", ip)).status).toBe(200);
  });

  it("limits all sign-in attempts per client IP", async () => {
    const ip = "198.51.100.30";
    for (let i = 0; i < 30; i++)
      expect((await login(`nobody${i}@iqoshaven.test`, ip)).status).toBe(401);
    expect((await login("other@iqoshaven.test", ip)).status).toBe(429);
    expect((await login("other@iqoshaven.test", "198.51.100.31")).status).toBe(200);
  });

  it("clears the identity window after a successful sign-in", async () => {
    const ip = "198.51.100.40";
    for (let i = 0; i < 9; i++) await login("reset@iqoshaven.test", ip, "wrong-password-entirely");
    expect((await login("reset@iqoshaven.test", ip)).status).toBe(200);
    for (let i = 0; i < 9; i++)
      expect((await login("reset@iqoshaven.test", ip, "wrong-password-entirely")).status).toBe(401);
  });

  it("fails closed when the replicated profile's shared limiter is unreachable", async () => {
    const replicated = await createApp(
      {
        ...env,
        RATE_LIMIT_PROFILE: "replicated",
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
      { pool, database: db },
    );
    await replicated.listen(0, "127.0.0.1");
    try {
      const response = await fetch(`${await replicated.getUrl()}/v1/auth/login`, {
        method: "POST",
        headers: { origin: ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "staff@iqoshaven.test", password: PASSWORD }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await envelope(response)).error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      await replicated.close();
    }
  });
});

describe("shared Redis limiter (real Redis)", () => {
  const redis = new Redis(QUEUE_REDIS_URL, { lazyConnect: true });
  const prefix = `ih:test:rl:${randomUUID()}:`;
  const rule = { limit: 5, windowMs: 60_000 };

  afterAll(async () => {
    const keys = await redis.keys(prefix + "*");
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  it("enforces one budget across instances under concurrency", async () => {
    const a = new RedisRateLimiter(redis, prefix);
    const b = new RedisRateLimiter(redis, prefix);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).consume("login:ip:x", rule)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    const denied = decisions.find((decision) => !decision.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(59_000);
    const ttl = await redis.pttl(prefix + "login:ip:x");
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("resets a key", async () => {
    const limiter = new RedisRateLimiter(redis, prefix);
    for (let i = 0; i < 6; i++) await limiter.consume("login:identity:y", rule);
    await limiter.reset("login:identity:y");
    expect((await limiter.consume("login:identity:y", rule)).allowed).toBe(true);
  });
});
