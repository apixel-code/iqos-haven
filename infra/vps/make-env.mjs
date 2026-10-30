// Writes one environment's files (roadmap steps 122/123, ADR 0100) ON THE SERVER, with fresh
// random secrets, so staging and production never share a key, password or signing identity. Nothing secret is printed; each service gets only the variables it needs, so
// the age-ticket private key reaches the storefront alone and the migration identity reaches the
// migrate job alone. Refuses to overwrite an existing env directory (rotation is deliberate).
//
//   staging:    node make-env.mjs --store https://… --admin https://… --media https://… \
//                 --mail-allow "@example.com,owner@example.com"
//   production: node make-env.mjs --env production --store … --admin … --media … \
//                 --age-policy <approved version, BI-04>
// Production starts with email delivery OFF: the provider key and verified sender (BI-07) are
// added to worker.env when ready, then EMAIL_SEND_ENABLED=true.
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
    env: { type: "string", default: "staging" },
    "age-policy": { type: "string" },
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
const deployment = values.env;
if (deployment !== "staging" && deployment !== "production")
  throw new Error("--env must be staging or production");
const production = deployment === "production";
const mailAllow = values["mail-allow"];
if (!production && !mailAllow)
  throw new Error("--mail-allow is required (staging never emails customers)");
const agePolicy = production ? values["age-policy"] : "staging";
if (!agePolicy || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(agePolicy) || agePolicy === "unapproved")
  throw new Error("--age-policy <approved version> is required in production (BI-04)");
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

const base = { NODE_ENV: "production", APP_ENV: deployment, LOG_LEVEL: "info" };
const ageVerify = {
  AGE_TICKET_PUBLIC_KEYS: `${ageKid}:${agePublic.toString("base64url")}`,
  // Staging: a placeholder. Production: the approved wording/version (BI-04).
  AGE_POLICY_VERSION: agePolicy,
};
const storage = {
  S3_ENDPOINT: media,
  S3_PUBLIC_ENDPOINT: media,
  S3_REGION: "me-central-1",
  S3_ACCESS_KEY: "ih_service",
  S3_SECRET_KEY: minioService,
  S3_FORCE_PATH_STYLE: "true",
};
// Staging: Mailpit is the only SMTP target, nothing leaves the server (read it through an SSH
// tunnel). Production: off until the provider and the verified sender are configured (BI-07).
const email = production
  ? { EMAIL_SEND_ENABLED: "false", EMAIL_PROVIDER: "resend" }
  : {
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
