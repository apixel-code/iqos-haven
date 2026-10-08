import { loadEnv, loadLocalEnvFile, workerEnvSchema, ConfigurationError } from "@ih/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createDatabase, createPool } from "@ih/db";
import { createLogger, errorSummary } from "@ih/logger";
import { bounded } from "./lifecycle";
import { EffectRunner, startEffectWorkers, systemProbeHandler } from "./effects";
import { BullEffectEnqueuer, createQueueConnection } from "./queue";
import { EffectReconciler } from "./reconciler";
import { OutboxRelay } from "./relay";
import { Scheduler } from "./scheduler";
import { startWorker, type WorkerRuntime } from "./runtime";
const SHUTDOWN_TIMEOUT_MS = 20000;
async function main(): Promise<void> {
  loadLocalEnvFile();
  const env = loadEnv(workerEnvSchema);
  const log = createLogger({ service: "worker", level: env.LOG_LEVEL });
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    applicationName: "ih-worker",
  });
  const database = createDatabase(pool);
  const connection = createQueueConnection(env.QUEUE_REDIS_URL);
  connection.on("error", (error) => log.warn(errorSummary(error), "queue connection error"));
  const enqueuer = new BullEffectEnqueuer(connection);
  // Lease owner identifies this process in outbox/effect rows; no secrets or personal data.
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const relay = new OutboxRelay({ db: database, enqueuer, owner, log });
  const runner = new EffectRunner({
    db: database,
    owner,
    log,
    handlers: [systemProbeHandler],
    retries: enqueuer,
  });
  const reconciler = new EffectReconciler({ db: database, enqueuer, log });
  // Scheduled jobs (daily summary, rollups, cleanup) register here in their roadmap steps.
  const scheduler = new Scheduler({ db: database, owner, log, jobs: [] });
  let effectWorkers: { stop(): Promise<void> } | undefined;
  let runtime: WorkerRuntime | undefined;
  let starting: Promise<WorkerRuntime> | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  // Idempotent: startup failure and a concurrent signal may both close resources.
  const closeResources = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        // A signal during startup waits for it to settle so nothing half-started survives.
        const started = await starting?.catch(() => undefined);
        // Relay first: finish the current pass so no claim is left half-marked.
        await scheduler.stop();
        await reconciler.stop();
        await relay.stop();
        // Waits for active effect jobs; unfinished leases expire and are reclaimed.
        await effectWorkers?.stop();
        await enqueuer.close();
        // Waits for active jobs; the shutdown deadline bounds it.
        await (runtime ?? started)?.stop();
      } finally {
        connection.disconnect();
        await database.$disconnect();
        await pool.end();
      }
    })());
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ reason }, "worker shutting down");
    const deadline = setTimeout(() => {
      log.error("graceful shutdown deadline exceeded");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      await closeResources();
      clearTimeout(deadline);
      log.info("worker stopped");
      process.exit(reason === "SIGTERM" || reason === "SIGINT" ? 0 : 1);
    } catch (error) {
      log.error(errorSummary(error), "worker shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    starting = startWorker({
      appEnv: env.APP_ENV,
      concurrency: env.WORKER_CONCURRENCY,
      startupTimeoutMs: env.WORKER_STARTUP_TIMEOUT_MS,
      log,
      pool,
      connection,
      onFatal: (reason) => void shutdown(reason),
    });
    runtime = await starting;
    // A signal during startup already began closing resources; do not start on a closing pool.
    if (!stopping) {
      effectWorkers = startEffectWorkers(runner, connection, env.WORKER_CONCURRENCY, log);
      relay.start();
      reconciler.start();
      scheduler.start();
    }
  } catch (error) {
    log.error(errorSummary(error), "worker startup failed");
    await bounded(closeResources(), 5000).catch(() => connection.disconnect());
    throw error;
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : "Worker startup failed; inspect safe service diagnostics.",
  );
  process.exit(1);
});
