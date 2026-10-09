import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const nodeEnvSchema = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;
export const deploymentEnvSchema = z.enum(["development", "test", "staging", "production"]);
export type DeploymentEnv = z.infer<typeof deploymentEnvSchema>;
const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const postgresUrl = z.string().refine((value) => {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "must be a postgres:// connection URL");
const redisUrl = z.string().refine((value) => {
  try {
    return ["redis:", "rediss:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "must be a redis:// or rediss:// URL");
/**
 * host:port identifies a Redis instance; eviction policy is instance-wide, so the DB index is ignored.
 * Best-effort: loopback aliases are unified, but distinct DNS names for one host are not resolved; provisioning
 * must still give the cache its own instance.
 */
export function redisInstance(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  // Loopback aliases name the same local instance.
  const loopback = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  return (loopback ? "loopback" : host) + ":" + (parsed.port || "6379");
}
/**
 * Optional cache Redis (replicated profile only). It may evict, so it must never be the queue
 * instance (architecture §8: cache eviction policy never mixes with queue Redis).
 */
const separateCacheRedis = (
  value: { QUEUE_REDIS_URL: string; CACHE_REDIS_URL?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (
    value.CACHE_REDIS_URL &&
    redisInstance(value.CACHE_REDIS_URL) === redisInstance(value.QUEUE_REDIS_URL)
  )
    ctx.addIssue({
      code: "custom",
      path: ["CACHE_REDIS_URL"],
      message: "must be a different Redis instance from QUEUE_REDIS_URL",
    });
};
const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "must be HTTP(S)");
const port = z.coerce.number().int().min(1).max(65535);
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  APP_ENV: deploymentEnvSchema.default("development"),
  LOG_LEVEL: logLevel.default("info"),
});
/** "true"/"false" only. Never Boolean(value): Boolean("false") is true. */
const strictBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
/** Comma list of exact addresses or "@domain" entries, normalized to lower case. */
const recipientAllowlist = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine(
    (entries) =>
      entries.every((entry) =>
        /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(entry),
      ),
    "entries must be addresses or @domain",
  );
const LOCAL_SMTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "mailpit"]);

/**
 * Email adapter configuration (roadmap step 25). Sending is off unless EMAIL_SEND_ENABLED is
 * exactly "true". Provider, sender domain and recipients are business input BI-07.
 */
export const emailEnvFields = {
  EMAIL_SEND_ENABLED: strictBoolean,
  /** smtp = SMTP relay / local Mailpit; resend = Resend HTTP API (ADR 0004). */
  EMAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  EMAIL_FROM: z.email().optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: port.default(1025),
  SMTP_SECURE: strictBoolean,
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  RESEND_API_KEY: z
    .string()
    .regex(/^re_[A-Za-z0-9_]{8,}$/, "must be a Resend API key")
    .optional(),
  // The bearer key must never travel in cleartext: https, except a local test stub.
  RESEND_API_URL: httpUrl.default("https://api.resend.com").refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || LOCAL_SMTP_HOSTS.has(url.hostname);
  }, "must be https (or a local stub)"),
  EMAIL_RECIPIENT_ALLOWLIST: recipientAllowlist,
};
const emailSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    EMAIL_SEND_ENABLED: boolean;
    EMAIL_PROVIDER: "smtp" | "resend";
    EMAIL_FROM?: string | undefined;
    SMTP_HOST?: string | undefined;
    SMTP_USER?: string | undefined;
    SMTP_PASSWORD?: string | undefined;
    RESEND_API_KEY?: string | undefined;
    RESEND_API_URL: string;
    EMAIL_RECIPIENT_ALLOWLIST: string[];
  },
  ctx: z.RefinementCtx,
) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD))
    issue("SMTP_PASSWORD", "SMTP_USER and SMTP_PASSWORD are set together");
  if (!value.EMAIL_SEND_ENABLED) return;
  const local = value.APP_ENV === "development" || value.APP_ENV === "test";
  if (!value.EMAIL_FROM) issue("EMAIL_FROM", "required when EMAIL_SEND_ENABLED=true");
  if (value.EMAIL_PROVIDER === "smtp") {
    if (!value.SMTP_HOST) issue("SMTP_HOST", "required when EMAIL_SEND_ENABLED=true");
    // Local and test runs may only deliver to a local sink such as Mailpit.
    if (local && value.SMTP_HOST && !LOCAL_SMTP_HOSTS.has(value.SMTP_HOST.toLowerCase()))
      issue("SMTP_HOST", "development/test may only send to a local SMTP sink");
  } else {
    if (!value.RESEND_API_KEY) issue("RESEND_API_KEY", "required for EMAIL_PROVIDER=resend");
    // Tests never reach the real Resend API; only a local stub.
    if (value.APP_ENV === "test" && !LOCAL_SMTP_HOSTS.has(new URL(value.RESEND_API_URL).hostname))
      issue("RESEND_API_URL", "tests may only use a local Resend stub");
    // Before production, real delivery is limited to explicitly allowed recipients.
    if (value.APP_ENV === "development" && value.EMAIL_RECIPIENT_ALLOWLIST.length === 0)
      issue("EMAIL_RECIPIENT_ALLOWLIST", "required for Resend outside production");
  }
  // Staging never emails real customers: an explicit recipient allowlist is mandatory.
  if (value.APP_ENV === "staging" && value.EMAIL_RECIPIENT_ALLOWLIST.length === 0)
    issue("EMAIL_RECIPIENT_ALLOWLIST", "required in staging when sending is enabled");
};

const bucketName = (fallback: string) =>
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be a valid bucket name")
    .default(fallback);

/**
 * Object storage (roadmap step 26). Without S3_ENDPOINT the SDK targets AWS (provider is BI-06);
 * without keys it uses the platform credential chain (service identity), never a root account.
 */
export const storageEnvFields = {
  S3_ENDPOINT: httpUrl.optional(),
  S3_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "must be a region like me-central-1")
    .default("me-central-1"),
  S3_ACCESS_KEY: z.string().min(3).optional(),
  S3_SECRET_KEY: z.string().min(8).optional(),
  S3_FORCE_PATH_STYLE: strictBoolean,
  S3_BUCKET_QUARANTINE: bucketName("ih-quarantine"),
  S3_BUCKET_MEDIA: bucketName("ih-media"),
  S3_BUCKET_REPORTS: bucketName("ih-reports"),
};
const storageSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    S3_ENDPOINT?: string | undefined;
    S3_ACCESS_KEY?: string | undefined;
    S3_SECRET_KEY?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (Boolean(value.S3_ACCESS_KEY) !== Boolean(value.S3_SECRET_KEY))
    ctx.addIssue({ code: "custom", path: ["S3_SECRET_KEY"], message: "keys are set together" });
  if (
    value.S3_ENDPOINT &&
    (value.APP_ENV === "staging" || value.APP_ENV === "production") &&
    new URL(value.S3_ENDPOINT).protocol !== "https:"
  )
    ctx.addIssue({
      code: "custom",
      path: ["S3_ENDPOINT"],
      message: "must be https outside development",
    });
};

/**
 * Private service-to-service auth (roadmap step 26). Verifiers list the callers they accept as
 * "service:keyId:base64urlSecret" entries (comma separated; several key ids allow rotation).
 */
const serviceName = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const serviceSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be base64url")
  .refine((value) => Buffer.from(value, "base64url").length >= 32, "must decode to ≥ 32 bytes");
export const serviceKeysSchema = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const keys: Array<{ service: string; keyId: string; secret: string }> = [];
    for (const entry of value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)) {
      const [service = "", id = "", secret = "", ...rest] = entry.split(":");
      if (
        rest.length ||
        !serviceName.safeParse(service).success ||
        !keyId.safeParse(id).success ||
        !serviceSecret.safeParse(secret).success
      ) {
        ctx.addIssue({
          code: "custom",
          message: "entries must be service:keyId:secret (≥ 32 bytes)",
        });
        return z.NEVER;
      }
      if (keys.some((key) => key.service === service && key.keyId === id)) {
        ctx.addIssue({ code: "custom", message: "duplicate service:keyId entry" });
        return z.NEVER;
      }
      keys.push({ service, keyId: id, secret });
    }
    return keys;
  });
/** Signing identity of a calling service (worker, storefront): all three or none. */
export const serviceSignerFields = {
  INTERNAL_SERVICE_ID: serviceName.optional(),
  INTERNAL_SERVICE_KEY_ID: keyId.optional(),
  INTERNAL_SERVICE_KEY: serviceSecret.optional(),
};
const signerComplete = (
  value: {
    INTERNAL_SERVICE_ID?: string | undefined;
    INTERNAL_SERVICE_KEY_ID?: string | undefined;
    INTERNAL_SERVICE_KEY?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  const set = [
    value.INTERNAL_SERVICE_ID,
    value.INTERNAL_SERVICE_KEY_ID,
    value.INTERNAL_SERVICE_KEY,
  ].filter(Boolean);
  if (set.length !== 0 && set.length !== 3)
    ctx.addIssue({
      code: "custom",
      path: ["INTERNAL_SERVICE_KEY"],
      message: "service id, key id and key are set together",
    });
};

export const apiEnvSchema = baseEnvSchema
  .extend({
    API_PORT: port.default(4000),
    API_HOST: z.string().default("127.0.0.1"),
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    QUEUE_REDIS_URL: redisUrl,
    CACHE_REDIS_URL: redisUrl.optional(),
    ...storageEnvFields,
    INTERNAL_SERVICE_KEYS: serviceKeysSchema,
  })
  .superRefine((value, ctx) => {
    separateCacheRedis(value, ctx);
    storageSafety(value, ctx);
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export const workerEnvSchema = baseEnvSchema
  .extend({
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    QUEUE_REDIS_URL: redisUrl,
    CACHE_REDIS_URL: redisUrl.optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    ...emailEnvFields,
    ...storageEnvFields,
    ...serviceSignerFields,
  })
  .superRefine((value, ctx) => {
    separateCacheRedis(value, ctx);
    emailSafety(value, ctx);
    storageSafety(value, ctx);
    signerComplete(value, ctx);
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export const storefrontEnvSchema = baseEnvSchema.extend({
  STOREFRONT_PORT: port.default(3000),
  API_INTERNAL_URL: httpUrl,
});
export const adminEnvSchema = baseEnvSchema.extend({
  ADMIN_PORT: port.default(3001),
  API_INTERNAL_URL: httpUrl,
});
export const migrationEnvSchema = baseEnvSchema.extend({ DATABASE_MIGRATION_URL: postgresUrl });
export const integrationTestEnvSchema = z.object({ DATABASE_TEST_URL: postgresUrl });
/** Email integration tests: a local SMTP sink and its HTTP API (Mailpit). Test-only. */
export const emailIntegrationTestEnvSchema = z.object({
  // Integration tests really send: only ever to a local sink, whatever a developer .env says.
  SMTP_HOST: z
    .string()
    .min(1)
    .default("localhost")
    .refine((host) => LOCAL_SMTP_HOSTS.has(host.toLowerCase()), "must be a local SMTP sink"),
  SMTP_PORT: port.default(1025),
  MAILPIT_URL: httpUrl.default("http://localhost:8025"),
});
/** Storage integration tests: local MinIO with the least-privilege service user. Test-only. */
export const storageIntegrationTestEnvSchema = z.object({
  ...storageEnvFields,
  S3_ENDPOINT: httpUrl.refine(
    (value) => LOCAL_SMTP_HOSTS.has(new URL(value).hostname),
    "storage tests only run against a local MinIO",
  ),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
});
/** Worker integration tests also need the local/CI queue Redis (unique queue names per run). */
export const queueIntegrationTestEnvSchema = integrationTestEnvSchema.extend({
  QUEUE_REDIS_URL: redisUrl,
});

export class ConfigurationError extends Error {}
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Report only key names, never validation messages from custom refinements containing input values.
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(root)"))];
    throw new ConfigurationError(
      "Invalid environment configuration; check keys: " + keys.join(", "),
    );
  }
  if (
    source.NODE_ENV === "production" &&
    !["staging", "production"].includes(source.APP_ENV ?? "")
  ) {
    throw new ConfigurationError(
      "Invalid environment configuration; set APP_ENV to staging or production",
    );
  }
  return result.data;
}
export function loadLocalEnvFile(startDir: string = process.cwd()): string | undefined {
  if (
    process.env.NODE_ENV === "production" ||
    ["production", "staging"].includes(process.env.APP_ENV ?? "")
  )
    return undefined;
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Test DDL is permitted only on a dedicated, explicitly named test database. */
export function assertTestDatabase(url: string, productionUrl?: string): void {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/i.test(database) || parsed.searchParams.has("schema")) {
    throw new ConfigurationError(
      "DATABASE_TEST_URL must target a dedicated *_test database, without a schema override",
    );
  }
  if (productionUrl) {
    const other = new URL(productionUrl);
    if (
      parsed.hostname === other.hostname &&
      (parsed.port || "5432") === (other.port || "5432") &&
      parsed.pathname === other.pathname
    ) {
      throw new ConfigurationError("Test database must be separate from the runtime database");
    }
  }
}
