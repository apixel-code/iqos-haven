import { createPrivateKey, createPublicKey } from "node:crypto";
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
/**
 * Error reporting (roadmap step 125, ADR 0096): off unless SENTRY_DSN is set. Events are scrubbed
 * of request data and users before they leave the process.
 */
const sentryEnvFields = {
  SENTRY_DSN: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", "must be https")
    .optional(),
  /** Release tag, e.g. the deployed commit. */
  SENTRY_RELEASE: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
};
/** Exact addresses only, at most ten, lower case (ops alerts, step 125). */
const opsRecipients = z
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
      entries.length <= 10 &&
      entries.every((entry) => /^[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(entry)),
    "up to ten email addresses",
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

/**
 * argon2id cost (architecture §11: benchmark on the production runtime with
 * `pnpm identity:benchmark`). Floors follow OWASP's minimum (19 MiB, t=2).
 */
export const passwordHashEnvFields = {
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
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
  /** Browser-facing endpoint for presigned upload/download URLs (defaults to S3_ENDPOINT). */
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
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
    S3_PUBLIC_ENDPOINT?: string | undefined;
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
  if (
    value.S3_PUBLIC_ENDPOINT &&
    (value.APP_ENV === "staging" || value.APP_ENV === "production") &&
    new URL(value.S3_PUBLIC_ENDPOINT).protocol !== "https:"
  )
    ctx.addIssue({
      code: "custom",
      path: ["S3_PUBLIC_ENDPOINT"],
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

/**
 * Browser origins and rate limiting (roadmap step 32, architecture §11). State-changing
 * cookie-authenticated requests must carry an Origin from these lists. Defaults are the local
 * gateway ports; staging/production must set https origins explicitly.
 */
const originList = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(httpUrl.refine((value) => new URL(value).origin === value, "must be a bare origin"))
        .min(1)
        .max(10),
    );
export const securityEnvFields = {
  ADMIN_ORIGINS: originList("http://localhost:8081"),
  STOREFRONT_ORIGINS: originList("http://localhost:8080"),
  /** budget: local limiter is authoritative (one API process); replicated: shared cache Redis. */
  RATE_LIMIT_PROFILE: z.enum(["budget", "replicated"]).default("budget"),
  /** Keyed-hash secret for limiter keys; identical on all replicas. Required when replicated. */
  RATE_LIMIT_KEY_SECRET: z.string().min(32).optional(),
  RATE_LIMIT_LOCAL_MAX_KEYS: z.coerce.number().int().min(1000).max(1_000_000).default(50_000),
  /** Maximum API replicas; local outage fallbacks divide cluster budgets by this. */
  RATE_LIMIT_MAX_REPLICAS: z.coerce.number().int().min(1).max(64).default(1),
};
const securitySafety = (
  value: {
    APP_ENV: DeploymentEnv;
    ADMIN_ORIGINS: string[];
    STOREFRONT_ORIGINS: string[];
    RATE_LIMIT_PROFILE: "budget" | "replicated";
    RATE_LIMIT_KEY_SECRET?: string | undefined;
    RATE_LIMIT_MAX_REPLICAS: number;
    CACHE_REDIS_URL?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  const deployed = value.APP_ENV === "staging" || value.APP_ENV === "production";
  for (const field of ["ADMIN_ORIGINS", "STOREFRONT_ORIGINS"] as const) {
    if (deployed && value[field].some((origin) => !origin.startsWith("https://")))
      ctx.addIssue({ code: "custom", path: [field], message: "must be https outside development" });
  }
  if (value.ADMIN_ORIGINS.some((origin) => value.STOREFRONT_ORIGINS.includes(origin)))
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_ORIGINS"],
      message: "admin and storefront origins must differ",
    });
  // Budget (step 119, BI-06): the catalogue cache and the limiters live inside one API process.
  // A second process would have its own cache (local invalidation only) and its own limits, so
  // more replicas need the replicated profile and a shared cache Redis (architecture §9).
  if (value.RATE_LIMIT_PROFILE === "budget" && value.RATE_LIMIT_MAX_REPLICAS !== 1)
    ctx.addIssue({
      code: "custom",
      path: ["RATE_LIMIT_MAX_REPLICAS"],
      message: "the budget profile runs one API process; use the replicated profile for more",
    });
  if (value.RATE_LIMIT_PROFILE === "replicated") {
    if (!value.CACHE_REDIS_URL)
      ctx.addIssue({
        code: "custom",
        path: ["CACHE_REDIS_URL"],
        message: "required when replicated",
      });
    if (!value.RATE_LIMIT_KEY_SECRET)
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_KEY_SECRET"],
        message: "required when replicated",
      });
  }
};

/**
 * Catalogue read cache budgets (roadmap step 52, architecture §9). The API process owns the
 * cache: bounded entries/bytes, TTL at most 60 s, bounded concurrent database misses. The
 * replicated profile (RATE_LIMIT_PROFILE) shares entries through CACHE_REDIS_URL instead.
 */
export const catalogueCacheEnvFields = {
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
  CATALOG_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(2_000),
  CATALOG_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(65_536)
    .max(512 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  CATALOG_CACHE_MAX_CONCURRENT_MISSES: z.coerce.number().int().min(1).max(64).default(8),
  CATALOG_CACHE_MAX_QUEUED_MISSES: z.coerce.number().int().min(0).max(10_000).default(200),
};

/**
 * Age gate (roadmap step 55, architecture §9, ADR 0024). Verifiers (API, storefront) get only
 * public keys as "kid:base64urlRaw32" entries; several key ids allow rotation and a revoked key
 * is removed. The private key exists only in the storefront schema. The policy version and the
 * ticket lifetime are business input BI-04: "unapproved" is refused in production.
 */
const rawEd25519Key = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be base64url")
  .refine((value) => Buffer.from(value, "base64url").length === 32, "must decode to 32 bytes")
  .refine(
    (value) => Buffer.from(value, "base64url").toString("base64url") === value,
    "must be canonical base64url",
  );
/** Raw public key (base64url) of a raw Ed25519 seed, to check a signer against its key ring. */
function ed25519PublicKey(seed: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seed, "base64url"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
}
export const UNAPPROVED_AGE_POLICY = "unapproved";
export const ageVerifierEnvFields = {
  AGE_TICKET_PUBLIC_KEYS: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const keys: Array<{ kid: string; publicKey: string }> = [];
      for (const entry of value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)) {
        const [kid, publicKey, ...rest] = entry.split(":");
        if (
          rest.length ||
          !keyId.safeParse(kid).success ||
          !rawEd25519Key.safeParse(publicKey).success
        ) {
          ctx.addIssue({ code: "custom", message: "entries are kid:base64urlPublicKey" });
          return z.NEVER;
        }
        if (keys.some((key) => key.kid === kid)) {
          ctx.addIssue({ code: "custom", message: "duplicate key id" });
          return z.NEVER;
        }
        keys.push({ kid: kid!, publicKey: publicKey! });
      }
      if (keys.length > 8) {
        ctx.addIssue({ code: "custom", message: "at most 8 keys" });
        return z.NEVER;
      }
      return keys;
    }),
  AGE_POLICY_VERSION: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/)
    .default(UNAPPROVED_AGE_POLICY),
};
/** Storefront only: the signing identity and the remembered-acceptance lifetime. */
export const ageSignerEnvFields = {
  AGE_TICKET_KEY_ID: keyId.optional(),
  AGE_TICKET_PRIVATE_KEY: rawEd25519Key.optional(),
  /** 30 days is the architecture's proposal; the approved value is BI-04. Hard cap 30. */
  AGE_TICKET_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(30),
};
const ageSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    AGE_POLICY_VERSION: string;
    AGE_TICKET_PUBLIC_KEYS: Array<{ kid: string; publicKey: string }>;
    AGE_TICKET_KEY_ID?: string | undefined;
    AGE_TICKET_PRIVATE_KEY?: string | undefined;
  },
  ctx: z.RefinementCtx,
  /** The storefront signs; every other verifier only needs public keys. */
  role: "verifier" | "signer" = "verifier",
) => {
  const deployed = value.APP_ENV === "staging" || value.APP_ENV === "production";
  // Without keys every store route is refused: safe, but a deployment must not start that way.
  if (deployed && !value.AGE_TICKET_PUBLIC_KEYS.length)
    ctx.addIssue({
      code: "custom",
      path: ["AGE_TICKET_PUBLIC_KEYS"],
      message: "required outside development",
    });
  if (deployed && role === "signer" && !value.AGE_TICKET_PRIVATE_KEY)
    ctx.addIssue({
      code: "custom",
      path: ["AGE_TICKET_PRIVATE_KEY"],
      message: "the storefront needs its signing key outside development",
    });
  if (value.APP_ENV === "production" && value.AGE_POLICY_VERSION === UNAPPROVED_AGE_POLICY)
    ctx.addIssue({
      code: "custom",
      path: ["AGE_POLICY_VERSION"],
      message: "production needs the approved age policy version",
    });
  if (Boolean(value.AGE_TICKET_KEY_ID) !== Boolean(value.AGE_TICKET_PRIVATE_KEY))
    ctx.addIssue({
      code: "custom",
      path: ["AGE_TICKET_PRIVATE_KEY"],
      message: "key id and private key are set together",
    });
  // A signer whose own verifiers would reject its tickets is a misconfiguration: the key id
  // must be listed, and the listed public key must belong to this private key.
  if (value.AGE_TICKET_KEY_ID && value.AGE_TICKET_PRIVATE_KEY) {
    const listed = value.AGE_TICKET_PUBLIC_KEYS.find((key) => key.kid === value.AGE_TICKET_KEY_ID);
    if (!listed)
      ctx.addIssue({
        code: "custom",
        path: ["AGE_TICKET_KEY_ID"],
        message: "signing key id must be in AGE_TICKET_PUBLIC_KEYS",
      });
    else if (listed.publicKey !== ed25519PublicKey(value.AGE_TICKET_PRIVATE_KEY))
      ctx.addIssue({
        code: "custom",
        path: ["AGE_TICKET_PRIVATE_KEY"],
        message: "does not match the public key listed for its key id",
      });
  }
};

/**
 * For every service except the storefront: the age-ticket private key must not be in its
 * environment once deployed. The value itself is never kept, only whether one was present.
 */
export const foreignAgeSigningKeyField = {
  AGE_TICKET_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((value) => (value ? ("present" as const) : undefined)),
};
const noForeignAgeSigningKey = (
  value: { APP_ENV: DeploymentEnv; AGE_TICKET_PRIVATE_KEY?: "present" | undefined },
  ctx: z.RefinementCtx,
) => {
  if (
    value.AGE_TICKET_PRIVATE_KEY &&
    (value.APP_ENV === "staging" || value.APP_ENV === "production")
  )
    ctx.addIssue({
      code: "custom",
      path: ["AGE_TICKET_PRIVATE_KEY"],
      message: "only the storefront may hold the age-ticket signing key",
    });
};

/** Purpose-specific reset key ring (first entry signs; old entries retained for delivery overlap). */
export const resetEnvFields = {
  PASSWORD_RESET_KEYS: serviceKeysSchema
    .refine(
      (keys) => keys.every((key) => key.service === "reset"),
      "Reset keys require reset service",
    )
    .transform((keys) => {
      return keys.map(({ keyId, secret }) => ({ keyId, secret }));
    }),
  PASSWORD_RESET_ORIGIN: httpUrl
    .refine((value) => new URL(value).origin === value, "must be a bare origin")
    .optional(),
};
const resetSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    PASSWORD_RESET_KEYS: unknown[];
    PASSWORD_RESET_ORIGIN?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (value.PASSWORD_RESET_KEYS.length && !value.PASSWORD_RESET_ORIGIN)
    ctx.addIssue({
      code: "custom",
      path: ["PASSWORD_RESET_ORIGIN"],
      message: "required with reset keys",
    });
  if (
    (value.APP_ENV === "production" || value.APP_ENV === "staging") &&
    value.PASSWORD_RESET_ORIGIN &&
    !value.PASSWORD_RESET_ORIGIN.startsWith("https://")
  )
    ctx.addIssue({
      code: "custom",
      path: ["PASSWORD_RESET_ORIGIN"],
      message: "must be https outside development",
    });
};

export const invitationEnvFields = {
  STAFF_INVITATION_KEYS: serviceKeysSchema
    .refine(
      (keys) => keys.every((key) => key.service === "invite"),
      "Invitation keys require invite service",
    )
    .transform((keys) => keys.map(({ keyId, secret }) => ({ keyId, secret }))),
  STAFF_INVITATION_ORIGIN: httpUrl
    .refine((value) => new URL(value).origin === value, "must be a bare origin")
    .optional(),
};
const invitationSafety = (
  value: {
    APP_ENV: DeploymentEnv;
    STAFF_INVITATION_KEYS: unknown[];
    STAFF_INVITATION_ORIGIN?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (value.STAFF_INVITATION_KEYS.length && !value.STAFF_INVITATION_ORIGIN)
    ctx.addIssue({
      code: "custom",
      path: ["STAFF_INVITATION_ORIGIN"],
      message: "required with invitation keys",
    });
  if (
    (value.APP_ENV === "production" || value.APP_ENV === "staging") &&
    value.STAFF_INVITATION_ORIGIN &&
    !value.STAFF_INVITATION_ORIGIN.startsWith("https://")
  )
    ctx.addIssue({
      code: "custom",
      path: ["STAFF_INVITATION_ORIGIN"],
      message: "must be https outside development",
    });
};

/**
 * Accepted-quote signing (step 71). `quote:<keyId>:<secret>` entries; the first signs, the rest
 * still verify during rotation. Required in staging and production. Left empty in development
 * or test, the API signs with a key made at start-up, so quotes do not survive a restart.
 */
export const quoteEnvFields = {
  QUOTE_SIGNING_KEYS: serviceKeysSchema
    .refine(
      (keys) => keys.every((key) => key.service === "quote"),
      "Quote keys require quote service",
    )
    .transform((keys) => keys.map(({ keyId, secret }) => ({ keyId, secret }))),
  /** How long a shown total can be accepted. */
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
};
const quoteSafety = (
  value: { APP_ENV: DeploymentEnv; QUOTE_SIGNING_KEYS: unknown[] },
  ctx: z.RefinementCtx,
) => {
  if (
    !value.QUOTE_SIGNING_KEYS.length &&
    (value.APP_ENV === "staging" || value.APP_ENV === "production")
  )
    ctx.addIssue({
      code: "custom",
      path: ["QUOTE_SIGNING_KEYS"],
      message: "required outside development and test",
    });
};

export const confirmationEnvFields = {
  ORDER_CONFIRMATION_KEYS: serviceKeysSchema
    .refine(
      (keys) =>
        keys.every(
          (key) =>
            key.service === "confirmation" &&
            Buffer.from(key.secret, "base64url").length === 32 &&
            Buffer.from(key.secret, "base64url").toString("base64url") === key.secret,
        ),
      "Confirmation keys require confirmation service and canonical 32-byte secrets",
    )
    .transform((keys) => keys.map(({ keyId, secret }) => ({ keyId, secret }))),
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
    ...passwordHashEnvFields,
    ...resetEnvFields,
    ...invitationEnvFields,
    ...quoteEnvFields,
    ...confirmationEnvFields,
    /**
     * Whether the store accepts orders (step 77). Off by default: the order route answers 503
     * until the checkout gate (step 82) has passed and the Owner is ready to take orders.
     */
    CHECKOUT_SUBMISSION_ENABLED: strictBoolean.default(false),
    ...securityEnvFields,
    ...catalogueCacheEnvFields,
    ...ageVerifierEnvFields,
    ...foreignAgeSigningKeyField,
    ...sentryEnvFields,
  })
  .superRefine((value, ctx) => {
    ageSafety({ ...value, AGE_TICKET_PRIVATE_KEY: undefined }, ctx);
    noForeignAgeSigningKey(value, ctx);
    quoteSafety(value, ctx);
    if (
      value.CHECKOUT_SUBMISSION_ENABLED &&
      !value.ORDER_CONFIRMATION_KEYS.length &&
      (value.APP_ENV === "staging" || value.APP_ENV === "production")
    )
      ctx.addIssue({
        code: "custom",
        path: ["ORDER_CONFIRMATION_KEYS"],
        message: "required for checkout outside development and test",
      });
    separateCacheRedis(value, ctx);
    storageSafety(value, ctx);
    securitySafety(value, ctx);
    if (
      value.STAFF_INVITATION_ORIGIN &&
      !value.ADMIN_ORIGINS.includes(value.STAFF_INVITATION_ORIGIN)
    )
      ctx.addIssue({
        code: "custom",
        path: ["STAFF_INVITATION_ORIGIN"],
        message: "must be an allowed admin origin",
      });
    resetSafety(value, ctx);
    invitationSafety(value, ctx);
    if (value.PASSWORD_RESET_ORIGIN && !value.ADMIN_ORIGINS.includes(value.PASSWORD_RESET_ORIGIN))
      ctx.addIssue({
        code: "custom",
        path: ["PASSWORD_RESET_ORIGIN"],
        message: "must be an allowed admin origin",
      });
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;
/** One-time first-Owner bootstrap CLI (runtime role; no other services needed). */
export const bootstrapEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: postgresUrl,
  ...passwordHashEnvFields,
});
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>;

/** `pnpm launch:check` (step 124): the database to inspect, read-only. */
export const launchCheckEnvSchema = baseEnvSchema.extend({ DATABASE_URL: postgresUrl });
/**
 * `pnpm ops:backup` and `pnpm ops:restore-drill` (step 126, ADR 0098): the migration role (it
 * can read every table and the migration history), the backup folder, the separately held
 * encryption key, the retention (BI-08: 30 days) and where pg_dump runs (BACKUP_PG_TOOLS).
 */
export const backupEnvSchema = baseEnvSchema
  .extend({
    DATABASE_MIGRATION_URL: postgresUrl,
    BACKUP_DIR: z.string().min(1),
    BACKUP_ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "must be 32 bytes, base64url (pnpm ops:backup-key)"),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    BACKUP_POSTGRES_SERVICE: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a Compose service name")
      .default("postgres"),
    /** compose: tools run in that Compose service; local: the ops image's own client (122b). */
    BACKUP_PG_TOOLS: z.enum(["compose", "local"]).default("compose"),
    ...storageEnvFields,
  })
  .superRefine((value, ctx) => storageSafety(value, ctx));
export type BackupEnv = z.infer<typeof backupEnvSchema>;
/** `pnpm analytics:backfill` (step 107): the runtime database only. */
export const analyticsBackfillEnvSchema = baseEnvSchema.extend({ DATABASE_URL: postgresUrl });

export const workerEnvSchema = baseEnvSchema
  .extend({
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    QUEUE_REDIS_URL: redisUrl,
    CACHE_REDIS_URL: redisUrl.optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    ...emailEnvFields,
    ...resetEnvFields,
    ...invitationEnvFields,
    ...storageEnvFields,
    ...serviceSignerFields,
    /** Private API base URL for signed invalidation calls (step 52). */
    API_INTERNAL_URL: httpUrl.optional(),
    ...foreignAgeSigningKeyField,
    ...sentryEnvFields,
    /** Ops alert email recipients (step 125, Apixel's ops address); empty = alerts in logs only. */
    OPS_ALERT_RECIPIENTS: opsRecipients,
    /** Hours between reminders while an alert stays open. */
    OPS_ALERT_REMINDER_HOURS: z.coerce.number().int().min(1).max(72).default(6),
    /** Public storefront and admin URLs the synthetic check visits; unset = not checked. */
    SYNTHETIC_STOREFRONT_URL: httpUrl.optional(),
    SYNTHETIC_ADMIN_URL: httpUrl.optional(),
  })
  .superRefine((value, ctx) => {
    noForeignAgeSigningKey(value, ctx);
    separateCacheRedis(value, ctx);
    emailSafety(value, ctx);
    resetSafety(value, ctx);
    invitationSafety(value, ctx);
    storageSafety(value, ctx);
    signerComplete(value, ctx);
    // Deployed workers must be able to invalidate the API cache; locally the TTL is enough.
    if (value.APP_ENV === "staging" || value.APP_ENV === "production")
      for (const field of ["API_INTERNAL_URL", "INTERNAL_SERVICE_KEY"] as const)
        if (!value[field])
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "required outside development for cache invalidation",
          });
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export const storefrontEnvSchema = baseEnvSchema
  .extend({
    STOREFRONT_PORT: port.default(3000),
    API_INTERNAL_URL: httpUrl,
    ...ageVerifierEnvFields,
    ...ageSignerEnvFields,
    /** Origins the age decision POSTs are accepted from (the storefront's own). */
    STOREFRONT_ORIGINS: securityEnvFields.STOREFRONT_ORIGINS,
    /** How long an under-age answer keeps the device on the restricted page (BI-04). */
    AGE_RESTRICTED_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** How long the storefront holds the Owner's indexing policy (step 113). */
    SEO_POLICY_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  })
  .superRefine((value, ctx) => {
    ageSafety(value, ctx, "signer");
    if (
      (value.APP_ENV === "staging" || value.APP_ENV === "production") &&
      value.STOREFRONT_ORIGINS.some((origin) => !origin.startsWith("https://"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["STOREFRONT_ORIGINS"],
        message: "must be https outside development",
      });
  });
export type StorefrontEnv = z.infer<typeof storefrontEnvSchema>;
export const adminEnvSchema = baseEnvSchema
  .extend({
    ADMIN_PORT: port.default(3001),
    API_INTERNAL_URL: httpUrl,
    ...foreignAgeSigningKeyField,
  })
  .superRefine(noForeignAgeSigningKey);
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
