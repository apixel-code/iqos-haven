import { describe, expect, it } from "vitest";
import {
  apiEnvSchema,
  assertTestDatabase,
  emailIntegrationTestEnvSchema,
  loadEnv,
  redisInstance,
  workerEnvSchema,
} from "./index";

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
    expect(redisInstance("redis://[::1]:6380")).toBe(redisInstance("redis://localhost:6380"));
    expect(redisInstance("redis://127.0.0.1")).toBe(redisInstance("redis://localhost:6379"));
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

describe("email configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };
  it("is off by default and parses booleans strictly", () => {
    expect(loadEnv(workerEnvSchema, base).EMAIL_SEND_ENABLED).toBe(false);
    expect(
      loadEnv(workerEnvSchema, { ...base, EMAIL_SEND_ENABLED: "false" }).EMAIL_SEND_ENABLED,
    ).toBe(false);
    expect(() => loadEnv(workerEnvSchema, { ...base, EMAIL_SEND_ENABLED: "yes" })).toThrow(
      /EMAIL_SEND_ENABLED/,
    );
  });
  it("requires sender and host when enabled, and only a local sink in development/test", () => {
    const enabled = { ...base, EMAIL_SEND_ENABLED: "true" };
    expect(() => loadEnv(workerEnvSchema, enabled)).toThrow(/EMAIL_FROM/);
    const local = { ...enabled, EMAIL_FROM: "no-reply@iqoshaven.local", SMTP_HOST: "localhost" };
    expect(loadEnv(workerEnvSchema, local).EMAIL_SEND_ENABLED).toBe(true);
    expect(() =>
      loadEnv(workerEnvSchema, { ...local, APP_ENV: "test", SMTP_HOST: "smtp.provider.example" }),
    ).toThrow(/SMTP_HOST/);
  });
  it("demands a recipient allowlist in staging and validates entries", () => {
    const staging = {
      ...base,
      APP_ENV: "staging",
      EMAIL_SEND_ENABLED: "true",
      EMAIL_FROM: "no-reply@iqoshaven.com",
      SMTP_HOST: "smtp.provider.example",
    };
    expect(() => loadEnv(workerEnvSchema, staging)).toThrow(/EMAIL_RECIPIENT_ALLOWLIST/);
    expect(
      loadEnv(workerEnvSchema, {
        ...staging,
        EMAIL_RECIPIENT_ALLOWLIST: " QA@Apixel.net, @apixel.net ",
      }).EMAIL_RECIPIENT_ALLOWLIST,
    ).toEqual(["qa@apixel.net", "@apixel.net"]);
    expect(() =>
      loadEnv(workerEnvSchema, { ...staging, EMAIL_RECIPIENT_ALLOWLIST: "not an address" }),
    ).toThrow(/EMAIL_RECIPIENT_ALLOWLIST/);
  });
  it("sets SMTP credentials as a pair", () => {
    expect(() => loadEnv(workerEnvSchema, { ...base, SMTP_USER: "u" })).toThrow(/SMTP_PASSWORD/);
  });
});

describe("email integration test environment", () => {
  it("refuses a non-local SMTP host so tests can never email real people", () => {
    expect(loadEnv(emailIntegrationTestEnvSchema, {}).SMTP_HOST).toBe("localhost");
    expect(() =>
      loadEnv(emailIntegrationTestEnvSchema, { SMTP_HOST: "smtp.provider.example" }),
    ).toThrow(/SMTP_HOST/);
  });
});
