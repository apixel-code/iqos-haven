// Writes the staging environment files (roadmap step 122, ADR 0100) ON THE SERVER, with fresh
// random secrets. Nothing secret is printed; each service gets only the variables it needs, so
// the age-ticket private key reaches the storefront alone and the migration identity reaches the
// migrate job alone. Refuses to overwrite an existing env directory (rotation is deliberate).
//
//   node make-env.mjs --dir ./env --store https://… --admin https://… --media https://… \
//     --mail-allow "@example.com,owner@example.com"
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: "./env" },
    store: { type: "string" },
    admin: { type: "string" },
    media: { type: "string" },
    "mail-allow": { type: "string" },
  },
});
const origin = (name) => {
  const value = values[name];
  if (!value || new URL(value).origin !== value || !value.startsWith("https://"))
    throw new Error(`--${name} must be a bare https origin`);
  return value;
};
const store = origin("store");
const admin = origin("admin");
const media = origin("media");
const mailAllow = values["mail-allow"];
if (!mailAllow) throw new Error("--mail-allow is required (staging never emails customers)");
if (existsSync(values.dir)) throw new Error(`${values.dir} exists; refusing to overwrite secrets`);

const secret = () => randomBytes(32).toString("base64url");
const password = () => randomBytes(24).toString("base64url");
const age = generateKeyPairSync("ed25519");
const ageKid = "age-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
const ageSeed = age.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const agePublic = age.publicKey.export({ format: "der", type: "spki" }).subarray(-32);

const ownerPassword = password();
const appPassword = password();
const minioRoot = password();
const minioService = password();
const workerKey = secret();
const db = (user, pass) => `postgres://${user}:${pass}@postgres:5432/iqos_haven`;

const base = { NODE_ENV: "production", APP_ENV: "staging", LOG_LEVEL: "info" };
const ageVerify = {
  AGE_TICKET_PUBLIC_KEYS: `${ageKid}:${agePublic.toString("base64url")}`,
  // Staging only: the approved wording/version is BI-04 and is set before production.
  AGE_POLICY_VERSION: "staging",
};
const storage = {
  S3_ENDPOINT: media,
  S3_PUBLIC_ENDPOINT: media,
  S3_REGION: "me-central-1",
  S3_ACCESS_KEY: "ih_service",
  S3_SECRET_KEY: minioService,
  S3_FORCE_PATH_STYLE: "true",
};
// Mailpit is the only SMTP target: nothing leaves the server (read it through an SSH tunnel).
const email = {
  EMAIL_SEND_ENABLED: "true",
  EMAIL_PROVIDER: "smtp",
  EMAIL_FROM: "no-reply@" + new URL(store).hostname,
  SMTP_HOST: "mailpit",
  SMTP_PORT: "1025",
  SMTP_SECURE: "false",
  EMAIL_RECIPIENT_ALLOWLIST: mailAllow,
};
const resetKeys = `reset:k1:${secret()}`;
const inviteKeys = `invite:k1:${secret()}`;

const files = {
  "postgres.env": {
    POSTGRES_DB: "iqos_haven",
    POSTGRES_USER: "ih_owner",
    POSTGRES_PASSWORD: ownerPassword,
    IH_APP_PASSWORD: appPassword,
  },
  "minio.env": {
    MINIO_ROOT_USER: "ih_minio",
    MINIO_ROOT_PASSWORD: minioRoot,
    MINIO_SERVICE_USER: "ih_service",
    MINIO_SERVICE_PASSWORD: minioService,
    MINIO_ENDPOINT: "http://minio:9000",
    MINIO_INIT_RETRIES: "60",
  },
  "migrate.env": { ...base, DATABASE_MIGRATION_URL: db("ih_owner", ownerPassword) },
  "api.env": {
    ...base,
    API_HOST: "0.0.0.0",
    API_PORT: "4000",
    DATABASE_URL: db("ih_app", appPassword),
    QUEUE_REDIS_URL: "redis://redis-queue:6379",
    ...storage,
    ...ageVerify,
    ADMIN_ORIGINS: admin,
    STOREFRONT_ORIGINS: store,
    RATE_LIMIT_PROFILE: "budget",
    INTERNAL_SERVICE_KEYS: `worker:k1:${workerKey}`,
    PASSWORD_RESET_KEYS: resetKeys,
    PASSWORD_RESET_ORIGIN: admin,
    STAFF_INVITATION_KEYS: inviteKeys,
    STAFF_INVITATION_ORIGIN: admin,
    QUOTE_SIGNING_KEYS: `quote:k1:${secret()}`,
    ORDER_CONFIRMATION_KEYS: `confirmation:k1:${secret()}`,
    // Staging takes test orders once the deploy is verified; flip deliberately.
    CHECKOUT_SUBMISSION_ENABLED: "false",
  },
  "worker.env": {
    ...base,
    DATABASE_URL: db("ih_app", appPassword),
    QUEUE_REDIS_URL: "redis://redis-queue:6379",
    WORKER_CONCURRENCY: "2",
    API_INTERNAL_URL: "http://api:4000",
    INTERNAL_SERVICE_ID: "worker",
    INTERNAL_SERVICE_KEY_ID: "k1",
    INTERNAL_SERVICE_KEY: workerKey,
    ...storage,
    ...email,
    PASSWORD_RESET_KEYS: resetKeys,
    PASSWORD_RESET_ORIGIN: admin,
    STAFF_INVITATION_KEYS: inviteKeys,
    STAFF_INVITATION_ORIGIN: admin,
    SYNTHETIC_STOREFRONT_URL: store,
    SYNTHETIC_ADMIN_URL: admin,
  },
  "storefront.env": {
    ...base,
    STOREFRONT_PORT: "3000",
    API_INTERNAL_URL: "http://api:4000",
    ...ageVerify,
    AGE_TICKET_KEY_ID: ageKid,
    AGE_TICKET_PRIVATE_KEY: ageSeed.toString("base64url"),
    STOREFRONT_ORIGINS: store,
  },
  "admin.env": { ...base, ADMIN_PORT: "3001", API_INTERNAL_URL: "http://api:4000" },
};

mkdirSync(values.dir, { mode: 0o700 });
for (const [name, vars] of Object.entries(files))
  writeFileSync(
    join(values.dir, name),
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600, flag: "wx" },
  );
console.log(
  `Wrote ${Object.keys(files).length} env files to ${values.dir} (0600). No secrets shown.`,
);
