// Local browser-QA backend (see README.md): built API + worker consumers (media processing and
// signed cache invalidation) on an isolated
// `ih_test_*` schema of the TEST database (never the dev database). Synthetic accounts only.
// Stop with SIGINT; drop the schema afterwards with `node qa-server.cjs --drop <schema>`.
const { createRequire } = require("node:module");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const root = require("node:path").resolve(__dirname, "../..");
const api = createRequire(root + "/apps/api/package.json");
const worker = createRequire(root + "/apps/worker/package.json");
api("reflect-metadata");
process.chdir(root);
const config = api("@ih/config");
const { createDatabase, createPool } = api("@ih/db");
const { applyMigrations } = api("@ih/db/testing");
const { Argon2PasswordHasher, ObjectStorage, storageConfigFromEnv } = api("@ih/platform");
const { createLogger } = api("@ih/logger");

config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);

async function drop(schema) {
  if (!/^ih_test_[0-9a-f]{32}$/.test(schema)) throw new Error("not a QA schema");
  const pool = createPool({ connectionString: DATABASE_TEST_URL, applicationName: "ih-qa-drop" });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
  console.log("dropped", schema);
}

async function main() {
  if (process.argv[2] === "--drop") return drop(process.argv[3]);
  const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    applicationName: "ih-qa",
    searchPath: namespace,
  });
  const db = createDatabase(pool, { schema: namespace });
  await applyMigrations(pool, namespace);
  const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
  const password = "copper-lantern-river-71";
  for (const [email, key] of [
    ["owner.qa@iqoshaven.test", "owner"],
    ["staff.qa@iqoshaven.test", "staff"],
  ]) {
    const role = await db.role.findUniqueOrThrow({ where: { key } });
    await db.staffUser.create({
      data: {
        email,
        name: key === "owner" ? "Owner QA" : "Staff QA",
        roleId: role.id,
        passwordHash: await hasher.hash(password),
      },
    });
  }
  // A fresh worker key per run: the real HMAC guard verifies the invalidation calls.
  const workerKey = {
    service: "worker",
    keyId: "qa",
    secret: randomBytes(32).toString("base64url"),
  };
  const env = config.apiEnvSchema.parse({
    ...process.env,
    INTERNAL_SERVICE_KEYS: `${workerKey.service}:${workerKey.keyId}:${workerKey.secret}`,
    NODE_ENV: "development",
    APP_ENV: "development",
    LOG_LEVEL: "warn",
    DATABASE_URL: DATABASE_TEST_URL,
    ARGON2_MEMORY_KIB: 19456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
  });
  const { createApp } = api(root + "/apps/api/dist/bootstrap.js");
  const app = await createApp(env, { pool, database: db });
  await app.listen(4000, "127.0.0.1");

  // Worker loop (the real consumers, driven directly for this schema).
  const sharp = worker("sharp");
  sharp.concurrency(1);
  const { createMediaConsumer } = worker(root + "/apps/worker/dist/media.js");
  const { createRevalidateConsumer } = worker(root + "/apps/worker/dist/revalidate.js");
  const { EffectRunner } = worker(root + "/apps/worker/dist/effects.js");
  const log = createLogger({ service: "qa-worker", level: "warn" });
  const storage = new ObjectStorage(storageConfigFromEnv(env));
  const runner = new EffectRunner({
    db,
    owner: "qa-worker",
    log,
    handlers: [
      createMediaConsumer({ db, storage, log }),
      createRevalidateConsumer({
        target: { apiUrl: "http://127.0.0.1:4000", key: workerKey },
        log,
      }),
    ],
  });
  let stopping = false;
  (async () => {
    while (!stopping) {
      const effects = await db.consumerEffect.findMany({
        where: {
          consumer: { in: ["media_processor", "storefront_revalidate"] },
          status: { in: ["pending", "queued", "retry"] },
        },
        take: 20,
      });
      for (const e of effects)
        await runner
          .run({ eventId: e.eventId, effectId: e.id, consumer: e.consumer })
          .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  // QA-only status probe (loopback): counts, never row contents.
  const probe = http.createServer((_request, response) => {
    Promise.all([
      db.consumerEffect.groupBy({
        by: ["status", "externalReceipt"],
        where: { consumer: "storefront_revalidate" },
        _count: true,
      }),
      db.outboxEvent.count({ where: { eventType: "inventory.low" } }),
    ])
      .then(([revalidate, lowStockEvents]) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            revalidate: revalidate.map((row) => ({
              status: row.status,
              receipt: row.externalReceipt,
              count: row._count,
            })),
            lowStockEvents,
          }),
        );
      })
      .catch(() => response.writeHead(500).end());
  });
  probe.listen(4099, "127.0.0.1");
  console.log(`QA backend ready on :4000 schema=${namespace}`);
  const stop = async () => {
    stopping = true;
    probe.close();
    await app.close();
    storage.destroy();
    await db.$disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
main().catch((error) => {
  console.error("QA backend failed:", error.message);
  process.exit(1);
});
