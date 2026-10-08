import { loadEnv, loadLocalEnvFile, workerEnvSchema, ConfigurationError } from "@ih/config";
import { createPool } from "@ih/db";
import { createLogger, errorSummary } from "@ih/logger";
import { bounded } from "./lifecycle";
import { createQueueConnection } from "./queue";
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
  const connection = createQueueConnection(env.QUEUE_REDIS_URL);
  connection.on("error", (error) => log.warn(errorSummary(error), "queue connection error"));
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
        // Waits for active jobs; the shutdown deadline bounds it.
        await (runtime ?? started)?.stop();
      } finally {
        connection.disconnect();
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
