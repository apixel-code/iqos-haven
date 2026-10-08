import { describe, expect, it } from "vitest";
import { apiEnvSchema, loadEnv, assertTestDatabase, redisInstance, workerEnvSchema } from "./index";

describe("loadEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadEnv(apiEnvSchema, {
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      QUEUE_REDIS_URL: "redis://localhost:6379",
      API_PORT: "4100",
    });
    expect(env.API_PORT).toBe(4100);
    expect(env.NODE_ENV).toBe("development");
  });

  it("lists every invalid key without echoing secret values", () => {
    const run = () =>
      loadEnv(apiEnvSchema, { DATABASE_URL: "mysql://secret-pass@x", QUEUE_REDIS_URL: "" });
    expect(run).toThrow(/DATABASE_URL/);
    expect(run).toThrow(/QUEUE_REDIS_URL/);
    expect(run).not.toThrow(/secret-pass/);
  });
});

describe("environment and test-target safety", () => {
  it("rejects unsafe database targets", () => {
    expect(() => assertTestDatabase("postgres://u:p@localhost/iqos_haven")).toThrow();
    expect(() =>
      assertTestDatabase("postgres://u:p@localhost/iqos_haven_test?schema=public"),
    ).toThrow();
    expect(() =>
      assertTestDatabase(
        "postgres://u:p@localhost/iqos_haven_test",
        "postgres://other:secret@localhost/iqos_haven_test",
      ),
    ).toThrow();
    expect(() => assertTestDatabase("postgres://u:p@localhost/iqos_haven_test")).not.toThrow();
  });
  it("requires an explicit production deployment environment", () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@localhost/db",
        QUEUE_REDIS_URL: "redis://localhost",
      }),
    ).toThrow(/APP_ENV/);
  });
});

describe("queue/cache Redis separation", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://queue.internal:6379/0",
  };
  it("treats host:port as the instance, ignoring DB index and default port", () => {
    expect(redisInstance("redis://Queue.Internal/3")).toBe(
      redisInstance("rediss://queue.internal:6379/0"),
    );
    expect(redisInstance("redis://[::1]:6380")).toBe("[::1]:6380");
    expect(redisInstance("redis://cache:6380")).not.toBe(redisInstance("redis://cache:6379"));
  });
  it.each([apiEnvSchema, workerEnvSchema])("rejects a cache on the queue instance", (schema) => {
    expect(() =>
      loadEnv(schema, { ...base, CACHE_REDIS_URL: "redis://queue.internal:6379/1" }),
    ).toThrow(/CACHE_REDIS_URL/);
    expect(
      loadEnv(schema, { ...base, CACHE_REDIS_URL: "redis://cache.internal:6379" }),
    ).toMatchObject({
      CACHE_REDIS_URL: "redis://cache.internal:6379",
    });
    expect(loadEnv(schema, base).CACHE_REDIS_URL).toBeUndefined();
  });
});
