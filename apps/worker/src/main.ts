import { loadEnv, loadLocalEnvFile, workerEnvSchema, ConfigurationError } from "@ih/config";
import { createPool, pingDatabase } from "@ih/db";
import { createLogger, errorSummary } from "@ih/logger";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { checkQueuePolicy } from "./queue-policy";
import { QUEUES } from "./queues";
import { bounded, handleSystemJob } from "./lifecycle";
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
  const connection = new Redis(env.QUEUE_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });
  connection.on("error", (error) => log.warn(errorSummary(error), "queue connection error"));
  let worker: Worker | undefined;
  let stopping = false;
  const closeResources = async (): Promise<void> => {
    try {
      await worker?.close();
    } finally {
      connection.disconnect();
      await pool.end();
    }
  };
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "worker shutting down");
    const deadline = setTimeout(() => {
      log.error("graceful shutdown deadline exceeded");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      await closeResources();
      clearTimeout(deadline);
      log.info("worker stopped");
      process.exit(signal === "run-failure" ? 1 : 0);
    } catch (error) {
      log.error(errorSummary(error), "worker shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    if (!(await bounded(pingDatabase(pool), env.WORKER_STARTUP_TIMEOUT_MS)))
      throw new Error("Database unavailable");
    await bounded(connection.connect(), env.WORKER_STARTUP_TIMEOUT_MS);
    const policy = await bounded(
      connection.config("GET", "maxmemory-policy"),
      env.WORKER_STARTUP_TIMEOUT_MS,
    )
      .then((reply) => (Array.isArray(reply) ? String(reply[1]) : undefined))
      .catch(() => undefined);
    const policyCheck = checkQueuePolicy(policy, env.APP_ENV);
    if (!policyCheck.ok) {
      if (policyCheck.fatal) throw new Error("Unsafe queue configuration");
      log.warn(policyCheck.message);
    }
    worker = new Worker(QUEUES.system, handleSystemJob, {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      autorun: false,
    });
    worker.on("error", (error) => log.error(errorSummary(error), "worker infrastructure error"));
    worker.on("failed", (job, error) =>
      log.error(
        {
          jobType: job?.name === "healthcheck" ? "healthcheck" : "unsupported",
          ...errorSummary(error),
        },
        "job failed",
      ),
    );
    await bounded(worker.waitUntilReady(), env.WORKER_STARTUP_TIMEOUT_MS);
    void worker.run().catch((error) => {
      log.error(errorSummary(error), "worker run terminated");
      void shutdown("run-failure");
    });
    log.info({ queue: QUEUES.system, concurrency: env.WORKER_CONCURRENCY }, "worker started");
  } catch (error) {
    try {
      await bounded(closeResources(), 5000);
    } finally {
      connection.disconnect();
    }
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
