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
export const apiEnvSchema = baseEnvSchema
  .extend({
    API_PORT: port.default(4000),
    API_HOST: z.string().default("127.0.0.1"),
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    QUEUE_REDIS_URL: redisUrl,
    CACHE_REDIS_URL: redisUrl.optional(),
  })
  .superRefine(separateCacheRedis);
export type ApiEnv = z.infer<typeof apiEnvSchema>;
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
  EMAIL_FROM: z.email().optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: port.default(1025),
  SMTP_SECURE: strictBoolean,
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  EMAIL_RECIPIENT_ALLOWLIST: recipientAllowlist,
};
const emailSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    EMAIL_SEND_ENABLED: boolean;
    EMAIL_FROM?: string | undefined;
    SMTP_HOST?: string | undefined;
    SMTP_USER?: string | undefined;
    SMTP_PASSWORD?: string | undefined;
    EMAIL_RECIPIENT_ALLOWLIST: string[];
  },
  ctx: z.RefinementCtx,
) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD))
    issue("SMTP_PASSWORD", "SMTP_USER and SMTP_PASSWORD are set together");
  if (!value.EMAIL_SEND_ENABLED) return;
  if (!value.EMAIL_FROM) issue("EMAIL_FROM", "required when EMAIL_SEND_ENABLED=true");
  if (!value.SMTP_HOST) issue("SMTP_HOST", "required when EMAIL_SEND_ENABLED=true");
  // Local and test runs may only deliver to a local sink such as Mailpit.
  if (
    (value.APP_ENV === "development" || value.APP_ENV === "test") &&
    value.SMTP_HOST &&
    !LOCAL_SMTP_HOSTS.has(value.SMTP_HOST.toLowerCase())
  )
    issue("SMTP_HOST", "development/test may only send to a local SMTP sink");
  // Staging never emails real customers: an explicit recipient allowlist is mandatory.
  if (value.APP_ENV === "staging" && value.EMAIL_RECIPIENT_ALLOWLIST.length === 0)
    issue("EMAIL_RECIPIENT_ALLOWLIST", "required in staging when sending is enabled");
};

export const workerEnvSchema = baseEnvSchema
  .extend({
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    QUEUE_REDIS_URL: redisUrl,
    CACHE_REDIS_URL: redisUrl.optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    ...emailEnvFields,
  })
  .superRefine((value, ctx) => {
    separateCacheRedis(value, ctx);
    emailSafety(value, ctx);
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
