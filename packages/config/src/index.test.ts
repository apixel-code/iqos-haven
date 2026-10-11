import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adminEnvSchema,
  apiEnvSchema,
  assertTestDatabase,
  emailIntegrationTestEnvSchema,
  loadEnv,
  redisInstance,
  storefrontEnvSchema,
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

/** Deployed workers must be able to call the API's private invalidation route (step 52). */
const deployedWorker = {
  API_INTERNAL_URL: "http://api.internal:4000",
  INTERNAL_SERVICE_ID: "worker",
  INTERNAL_SERVICE_KEY_ID: "k1",
  INTERNAL_SERVICE_KEY: "s".repeat(43),
};

describe("catalogue cache configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };
  it("defaults to bounded budgets and never allows a TTL above 60 seconds", () => {
    expect(loadEnv(apiEnvSchema, base)).toMatchObject({
      CATALOG_CACHE_TTL_SECONDS: 60,
      CATALOG_CACHE_MAX_ENTRIES: 2000,
      CATALOG_CACHE_MAX_BYTES: 33554432,
      CATALOG_CACHE_MAX_CONCURRENT_MISSES: 8,
    });
    expect(() => loadEnv(apiEnvSchema, { ...base, CATALOG_CACHE_TTL_SECONDS: "61" })).toThrow(
      /CATALOG_CACHE_TTL_SECONDS/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...base, CATALOG_CACHE_MAX_BYTES: "0" })).toThrow(
      /CATALOG_CACHE_MAX_BYTES/,
    );
  });
  it("requires the worker's invalidation target outside development", () => {
    expect(loadEnv(workerEnvSchema, base).API_INTERNAL_URL).toBeUndefined();
    const staging = { ...base, APP_ENV: "staging" };
    expect(() => loadEnv(workerEnvSchema, staging)).toThrow(/API_INTERNAL_URL/);
    expect(() => loadEnv(workerEnvSchema, staging)).toThrow(/INTERNAL_SERVICE_KEY/);
    expect(loadEnv(workerEnvSchema, { ...staging, ...deployedWorker }).API_INTERNAL_URL).toBe(
      "http://api.internal:4000",
    );
  });
});

describe("age gate configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };
  const key = (byte: string) => Buffer.alloc(32, byte).toString("base64url");
  const store = { API_INTERNAL_URL: "http://localhost:4000" };
  const pair = (() => {
    const generated = generateKeyPairSync("ed25519");
    return {
      seed: generated.privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(-32)
        .toString("base64url"),
      publicKey: generated.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64url"),
    };
  })();
  const deployedStore = {
    ...store,
    STOREFRONT_ORIGINS: "https://shop.example",
    AGE_TICKET_KEY_ID: "k1",
    AGE_TICKET_PRIVATE_KEY: pair.seed,
    AGE_TICKET_PUBLIC_KEYS: `k1:${pair.publicKey}`,
  };
  it("parses the verifier key ring and refuses malformed or duplicate entries", () => {
    expect(loadEnv(apiEnvSchema, base)).toMatchObject({
      AGE_TICKET_PUBLIC_KEYS: [],
      AGE_POLICY_VERSION: "unapproved",
    });
    expect(
      loadEnv(apiEnvSchema, { ...base, AGE_TICKET_PUBLIC_KEYS: ` k1:${key("a")}, k2:${key("b")} ` })
        .AGE_TICKET_PUBLIC_KEYS,
    ).toEqual([
      { kid: "k1", publicKey: key("a") },
      { kid: "k2", publicKey: key("b") },
    ]);
    for (const bad of [
      `k1:${key("a")},k1:${key("b")}`,
      "k1:short",
      `k1:${key("a")}:extra`,
      key("a"),
    ])
      expect(() => loadEnv(apiEnvSchema, { ...base, AGE_TICKET_PUBLIC_KEYS: bad })).toThrow(
        /AGE_TICKET_PUBLIC_KEYS/,
      );
  });
  it("refuses the unapproved policy in production (BI-04)", () => {
    const production = { ...deployedStore, APP_ENV: "production", NODE_ENV: "production" };
    expect(() => loadEnv(storefrontEnvSchema, production)).toThrow(/AGE_POLICY_VERSION/);
    expect(
      loadEnv(storefrontEnvSchema, { ...production, AGE_POLICY_VERSION: "2026-11" })
        .AGE_POLICY_VERSION,
    ).toBe("2026-11");
    expect(
      loadEnv(storefrontEnvSchema, { ...deployedStore, APP_ENV: "staging" }).AGE_POLICY_VERSION,
    ).toBe("unapproved");
  });
  it("refuses to start a deployment without keys", () => {
    const staging = { ...store, APP_ENV: "staging" };
    expect(() => loadEnv(storefrontEnvSchema, staging)).toThrow(/AGE_TICKET_PUBLIC_KEYS/);
    expect(() =>
      loadEnv(storefrontEnvSchema, { ...staging, AGE_TICKET_PUBLIC_KEYS: `k1:${pair.publicKey}` }),
    ).toThrow(/AGE_TICKET_PRIVATE_KEY/);
    expect(() => loadEnv(apiEnvSchema, { ...base, APP_ENV: "staging" })).toThrow(
      /AGE_TICKET_PUBLIC_KEYS/,
    );
  });
  it("needs https storefront origins once deployed and bounds the rejection window", () => {
    expect(loadEnv(storefrontEnvSchema, store)).toMatchObject({
      STOREFRONT_ORIGINS: ["http://localhost:8080"],
      AGE_RESTRICTED_MINUTES: 15,
    });
    expect(() =>
      loadEnv(storefrontEnvSchema, {
        ...deployedStore,
        APP_ENV: "staging",
        STOREFRONT_ORIGINS: "http://shop.example",
      }),
    ).toThrow(/STOREFRONT_ORIGINS/);
    expect(() => loadEnv(storefrontEnvSchema, { ...store, AGE_RESTRICTED_MINUTES: "0" })).toThrow(
      /AGE_RESTRICTED_MINUTES/,
    );
  });
  it("caps the remembered acceptance at 30 days", () => {
    expect(loadEnv(storefrontEnvSchema, store).AGE_TICKET_TTL_DAYS).toBe(30);
    expect(() => loadEnv(storefrontEnvSchema, { ...store, AGE_TICKET_TTL_DAYS: "31" })).toThrow(
      /AGE_TICKET_TTL_DAYS/,
    );
  });
  it("gives the signing key to the storefront only, as a complete, self-verifiable identity", () => {
    const signer = { AGE_TICKET_KEY_ID: "k1", AGE_TICKET_PRIVATE_KEY: pair.seed };
    expect(() => loadEnv(storefrontEnvSchema, { ...store, ...signer })).toThrow(
      /AGE_TICKET_KEY_ID/,
    );
    expect(() =>
      loadEnv(storefrontEnvSchema, {
        ...store,
        AGE_TICKET_KEY_ID: "k1",
        AGE_TICKET_PUBLIC_KEYS: `k1:${pair.publicKey}`,
      }),
    ).toThrow(/AGE_TICKET_PRIVATE_KEY/);
    // The listed public key must belong to the private key (a rotation slip locks shoppers out).
    expect(() =>
      loadEnv(storefrontEnvSchema, {
        ...store,
        ...signer,
        AGE_TICKET_PUBLIC_KEYS: `k1:${key("a")}`,
      }),
    ).toThrow(/AGE_TICKET_PRIVATE_KEY/);
    const ok = loadEnv(storefrontEnvSchema, deployedStore);
    expect(ok.AGE_TICKET_PRIVATE_KEY).toBe(pair.seed);
    // Other services never keep the key, and refuse to start with it once deployed.
    const leaked = {
      ...base,
      ...deployedWorker,
      ...signer,
      AGE_POLICY_VERSION: "2026-11",
      AGE_TICKET_PUBLIC_KEYS: `k1:${pair.publicKey}`,
    };
    for (const schema of [apiEnvSchema, workerEnvSchema]) {
      const parsed = loadEnv(schema, { ...base, ...signer }) as Record<string, unknown>;
      expect(JSON.stringify(parsed)).not.toContain(pair.seed);
      expect(() => loadEnv(schema, { ...leaked, APP_ENV: "staging" })).toThrow(
        /AGE_TICKET_PRIVATE_KEY/,
      );
    }
    expect(() => loadEnv(adminEnvSchema, { ...store, ...signer, APP_ENV: "staging" })).toThrow(
      /AGE_TICKET_PRIVATE_KEY/,
    );
    expect(JSON.stringify(loadEnv(adminEnvSchema, { ...store, ...signer }))).not.toContain(
      key("s"),
    );
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
      ...deployedWorker,
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

describe("Resend configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
    EMAIL_SEND_ENABLED: "true",
    EMAIL_PROVIDER: "resend",
    EMAIL_FROM: "orders@iqoshaven.com",
  };
  it("needs an API key and, outside production, an allowlist", () => {
    expect(() => loadEnv(workerEnvSchema, base)).toThrow(/RESEND_API_KEY/);
    const keyed = { ...base, RESEND_API_KEY: "re_live_abcdefgh123" };
    expect(() => loadEnv(workerEnvSchema, keyed)).toThrow(/EMAIL_RECIPIENT_ALLOWLIST/);
    expect(
      loadEnv(workerEnvSchema, { ...keyed, EMAIL_RECIPIENT_ALLOWLIST: "@apixel.net" })
        .EMAIL_PROVIDER,
    ).toBe("resend");
    expect(
      loadEnv(workerEnvSchema, {
        ...keyed,
        ...deployedWorker,
        APP_ENV: "production",
        NODE_ENV: "production",
      }).EMAIL_PROVIDER,
    ).toBe("resend");
  });
  it("never lets tests reach the real Resend API", () => {
    const testEnv = {
      ...base,
      APP_ENV: "test",
      RESEND_API_KEY: "re_test_abcdefgh",
      EMAIL_RECIPIENT_ALLOWLIST: "@x.ae",
    };
    expect(() => loadEnv(workerEnvSchema, testEnv)).toThrow(/RESEND_API_URL/);
    expect(
      loadEnv(workerEnvSchema, { ...testEnv, RESEND_API_URL: "http://127.0.0.1:4010" })
        .RESEND_API_URL,
    ).toBe("http://127.0.0.1:4010");
  });
  it("refuses a cleartext API URL except for a local stub", () => {
    const prod = {
      ...base,
      APP_ENV: "production",
      NODE_ENV: "production",
      RESEND_API_KEY: "re_live_abcdefgh123",
    };
    expect(() =>
      loadEnv(workerEnvSchema, { ...prod, RESEND_API_URL: "http://api.resend.com" }),
    ).toThrow(/RESEND_API_URL/);
  });
  it("rejects malformed API keys", () => {
    expect(() => loadEnv(workerEnvSchema, { ...base, RESEND_API_KEY: "secret" })).toThrow(
      /RESEND_API_KEY/,
    );
  });
});

describe("browser origins and rate-limit profile", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };

  it("defaults to the local gateway origins and the budget profile", () => {
    const env = loadEnv(apiEnvSchema, base);
    expect(env.ADMIN_ORIGINS).toEqual(["http://localhost:8081"]);
    expect(env.STOREFRONT_ORIGINS).toEqual(["http://localhost:8080"]);
    expect(env.RATE_LIMIT_PROFILE).toBe("budget");
  });

  it("parses origin lists and rejects paths, http in production and shared origins", () => {
    const env = loadEnv(apiEnvSchema, {
      ...base,
      ADMIN_ORIGINS: "https://admin.iqoshaven.com, https://admin2.iqoshaven.com",
    });
    expect(env.ADMIN_ORIGINS).toHaveLength(2);
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, ADMIN_ORIGINS: "https://admin.iqoshaven.com/" }),
    ).toThrow(/ADMIN_ORIGINS/);
    expect(() => loadEnv(apiEnvSchema, { ...base, APP_ENV: "production" })).toThrow(
      /ADMIN_ORIGINS/,
    );
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, STOREFRONT_ORIGINS: "http://localhost:8081" }),
    ).toThrow(/ADMIN_ORIGINS/);
  });

  it("requires a cache Redis and a key secret for the replicated profile", () => {
    const run = () => loadEnv(apiEnvSchema, { ...base, RATE_LIMIT_PROFILE: "replicated" });
    expect(run).toThrow(/CACHE_REDIS_URL/);
    expect(run).toThrow(/RATE_LIMIT_KEY_SECRET/);
    const env = loadEnv(apiEnvSchema, {
      ...base,
      RATE_LIMIT_PROFILE: "replicated",
      CACHE_REDIS_URL: "redis://cache:6379",
      RATE_LIMIT_KEY_SECRET: "s".repeat(32),
    });
    expect(env.RATE_LIMIT_PROFILE).toBe("replicated");
  });
});

describe("purpose-specific reset configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };
  const key = Buffer.alloc(32, 8).toString("base64url");
  it("defaults to disabled, validates purpose/length and requires the admin origin", () => {
    expect(loadEnv(apiEnvSchema, base).PASSWORD_RESET_KEYS).toEqual([]);
    for (const PASSWORD_RESET_KEYS of [
      "reset:one:short",
      `worker:one:${key}`,
      `reset:one:${key},reset:one:${key}`,
    ])
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...base,
          PASSWORD_RESET_KEYS,
          PASSWORD_RESET_ORIGIN: "http://localhost:8081",
        }),
      ).toThrow();
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, PASSWORD_RESET_KEYS: `reset:one:${key}` }),
    ).toThrow(/PASSWORD_RESET_ORIGIN/);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        PASSWORD_RESET_KEYS: `reset:one:${key}`,
        PASSWORD_RESET_ORIGIN: "https://evil.test",
      }),
    ).toThrow(/PASSWORD_RESET_ORIGIN/);
    const parsed = loadEnv(apiEnvSchema, {
      ...base,
      PASSWORD_RESET_KEYS: `reset:one:${key}`,
      PASSWORD_RESET_ORIGIN: "http://localhost:8081",
    });
    expect(parsed.PASSWORD_RESET_KEYS[0]?.keyId).toBe("one");
  });
});

describe("invitation configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    QUEUE_REDIS_URL: "redis://localhost:6379",
  };
  const secret = Buffer.alloc(32, 1).toString("base64url");
  it("requires an independent invite-purpose key ring and an allowed bare admin origin", () => {
    expect(loadEnv(apiEnvSchema, base).STAFF_INVITATION_KEYS).toEqual([]);
    for (const STAFF_INVITATION_KEYS of [
      "invite:one:short",
      `reset:one:${secret}`,
      `invite:one:${secret},invite:one:${secret}`,
    ])
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...base,
          STAFF_INVITATION_KEYS,
          STAFF_INVITATION_ORIGIN: "http://localhost:8081",
        }),
      ).toThrow();
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, STAFF_INVITATION_KEYS: `invite:one:${secret}` }),
    ).toThrow(/STAFF_INVITATION_ORIGIN/);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        STAFF_INVITATION_KEYS: `invite:one:${secret}`,
        STAFF_INVITATION_ORIGIN: "https://evil.test",
      }),
    ).toThrow(/STAFF_INVITATION_ORIGIN/);
    expect(
      loadEnv(apiEnvSchema, {
        ...base,
        STAFF_INVITATION_KEYS: `invite:one:${secret}`,
        STAFF_INVITATION_ORIGIN: "http://localhost:8081",
      }).STAFF_INVITATION_KEYS[0]?.keyId,
    ).toBe("one");
  });
});
