// Child process of scripts/load/load-test.cjs (roadmap step 121): the BUILT API on the budget
// launch profile plus the worker's outbox relay and effect consumers, on one ih_test_* schema
// of the test database. Kept out of the load generator's process so measured latency is the
// server's, not a shared event loop's. Prints "READY <url>" and stops on SIGTERM.
"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const api = createRequire(path.join(root, "apps/api/package.json"));
const config = api("@ih/config");
const { createDatabase, createPool } = api("@ih/db");

async function main() {
  const schema = process.argv[2];
  if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
  process.chdir(root);
  config.loadLocalEnvFile();
  const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
  config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
  const storageEnv = config.loadEnv(config.storageIntegrationTestEnvSchema);
  // Budget launch profile (BI-06, ADR 0036 step 119): one API process, in-process catalogue
  // cache, local limiters, the default pool size. Keys come from the parent.
  const env = config.apiEnvSchema.parse({
    ...storageEnv,
    S3_FORCE_PATH_STYLE: "true",
    NODE_ENV: "test",
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    DATABASE_URL: DATABASE_TEST_URL,
    QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
    ARGON2_MEMORY_KIB: 19456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
    AGE_POLICY_VERSION: process.env.LOAD_AGE_POLICY,
    AGE_TICKET_PUBLIC_KEYS: process.env.LOAD_AGE_PUBLIC_KEYS,
    STOREFRONT_ORIGINS: process.env.LOAD_STORE_ORIGIN,
    ADMIN_ORIGINS: process.env.LOAD_ADMIN_ORIGIN,
    ORDER_CONFIRMATION_KEYS: process.env.LOAD_CONFIRMATION_KEYS,
    QUOTE_SIGNING_KEYS: process.env.LOAD_QUOTE_KEYS,
    CHECKOUT_SUBMISSION_ENABLED: "true",
    RATE_LIMIT_PROFILE: "budget",
    RATE_LIMIT_MAX_REPLICAS: "1",
  });
  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    applicationName: "ih-load-api",
    searchPath: schema,
    max: env.DATABASE_POOL_MAX,
  });
  const db = createDatabase(pool, { schema });
  const { createApp } = api(path.join(root, "apps/api/dist/bootstrap.js"));
  const app = await createApp(env, { pool, database: db });
  // Nest's shutdown hooks would end the process on SIGTERM before the queue keys are cleared.
  for (const signal of ["SIGINT", "SIGTERM"]) process.removeAllListeners(signal);
  await app.listen(0, "127.0.0.1");

  // The worker's relay and consumers, as in check-gate-e2e.cjs --serve (a private queue prefix;
  // email planned for real and handed to an adapter that sends nothing).
  const worker = createRequire(path.join(root, "apps/worker/package.json"));
  const dist = (name) => worker(path.join(root, `apps/worker/dist/${name}.js`));
  const { createEmailConsumer } = worker("@ih/application");
  const log = worker("@ih/logger").createLogger({ service: "load-worker", level: "warn" });
  const queue = dist("queue");
  const redis = queue.createQueueConnection(env.QUEUE_REDIS_URL);
  const prefix = queue.testQueuePrefix();
  const enqueuer = new queue.BullEffectEnqueuer(redis, prefix);
  const notifications = dist("order-notifications");
  const lowStock = dist("low-stock-notifications");
  const effects = dist("effects");
  const workerPool = createPool({
    connectionString: DATABASE_TEST_URL,
    applicationName: "ih-load-worker",
    searchPath: schema,
    max: 5,
  });
  const workerDb = createDatabase(workerPool, { schema });
  const runner = new effects.EffectRunner({
    db: workerDb,
    owner: "load-worker",
    log,
    handlers: [
      notifications.createNotificationConsumer({ log }),
      dist("analytics-rollup").createAnalyticsRollupConsumer({ log }),
      createEmailConsumer({
        from: "no-reply@iqoshaven.local",
        planners: {
          "order.created": notifications.newOrderEmailPlanner(workerDb),
          "inventory.low": lowStock.lowStockEmailPlanner(workerDb, log),
        },
        adapter: {
          send: async (message) => ({
            receipt: "load:" + message.deliveryKey,
            accepted: message.bcc.length,
            rejected: 0,
          }),
        },
      }),
    ],
  });
  const workers = effects.startEffectWorkers(runner, redis, 2, log, prefix);
  const relay = new (dist("relay").OutboxRelay)({
    db: workerDb,
    enqueuer,
    owner: "load-relay",
    log,
  });
  const ticking = setInterval(() => void relay.tick().catch(() => undefined), 1000);
  // Production defaults (stale after 5 minutes, a pass a minute): re-enqueues a job the queue
  // lost, e.g. one handed to Redis just as it stopped (steps 22–24, 117).
  const reconciler = new (dist("reconciler").EffectReconciler)({ db: workerDb, enqueuer, log });
  reconciler.start();
  console.log(`READY ${await app.getUrl()}`);
  // Pool saturation as the API sees it: open, idle and queued connection requests.
  const stats = setInterval(
    () => console.log(`POOL ${pool.totalCount} ${pool.idleCount} ${pool.waitingCount}`),
    500,
  );

  await new Promise((done) => process.once("SIGTERM", done).once("SIGINT", done));
  clearInterval(ticking);
  await reconciler.stop().catch(() => undefined);
  clearInterval(stats);
  await workers.stop().catch(() => undefined);
  await enqueuer.close().catch(() => undefined);
  const keys = await redis.keys(`${prefix}:*`).catch(() => []);
  if (keys.length) await redis.del(...keys).catch(() => undefined);
  redis.disconnect();
  await app.close();
  await db.$disconnect();
  await workerDb.$disconnect();
  await pool.end();
  await workerPool.end();
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
