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
export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: port.default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_REDIS_URL: redisUrl,
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export const workerEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
  QUEUE_REDIS_URL: redisUrl,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
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
