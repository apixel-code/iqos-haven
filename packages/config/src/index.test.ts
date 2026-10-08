import { describe, expect, it } from "vitest";
import { apiEnvSchema, loadEnv, assertTestDatabase } from "./index";

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
