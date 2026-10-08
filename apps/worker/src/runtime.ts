import type { DeploymentEnv } from "@ih/config";
import { pingDatabase, type Pool } from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import { bounded, handleSystemJob } from "./lifecycle";
import { workerOptions } from "./queue";
import {
  checkQueuePolicy,
  memoryPressure,
  MEMORY_WARN_RATIO,
  parseRedisInfo,
  type QueueRedisState,
} from "./queue-policy";
import { QUEUES } from "./queues";

export interface WorkerRuntimeOptions {
  readonly appEnv: DeploymentEnv;
  readonly concurrency: number;
  readonly startupTimeoutMs: number;
  readonly log: Logger;
  readonly pool: Pool;
  readonly connection: Redis;
  readonly queueName?: string;
  readonly processor?: (job: Job) => Promise<unknown>;
  /** Re-checks eviction policy and memory pressure after startup. */
  readonly monitorIntervalMs?: number;
  /** Called when the queue Redis becomes unsafe at runtime; the caller shuts down. */
  readonly onFatal: (reason: string) => void;
}

export interface WorkerRuntime {
  readonly worker: Worker;
  /** Stops taking jobs and waits for active jobs to finish. Does not close the connections. */
  stop(): Promise<void>;
}

export async function readQueueRedisState(connection: Redis): Promise<QueueRedisState> {
  return parseRedisInfo(await connection.info("memory"));
}

export async function startWorker(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const { appEnv, concurrency, startupTimeoutMs, log, pool, connection } = options;
  const queueName = options.queueName ?? QUEUES.system;
  if (!(await bounded(pingDatabase(pool), startupTimeoutMs)))
    throw new Error("Database unavailable");
  if (connection.status === "wait") await bounded(connection.connect(), startupTimeoutMs);
  const state = await bounded(readQueueRedisState(connection), startupTimeoutMs).catch(() => ({
    policy: undefined,
    usedMemory: undefined,
    maxMemory: undefined,
  }));
  const policyCheck = checkQueuePolicy(state.policy, appEnv);
  if (!policyCheck.ok) {
    if (policyCheck.fatal) {
      log.error(policyCheck.message);
      throw new Error("Unsafe queue configuration");
    }
    log.warn(policyCheck.message);
  }

  const worker = new Worker(
    queueName,
    options.processor ?? handleSystemJob,
    workerOptions(connection, concurrency),
  );
  worker.on("error", (error) => log.error(errorSummary(error), "worker infrastructure error"));
  // Job names and IDs only: payloads may reference customer data.
  worker.on("failed", (job, error) =>
    log.error(
      { queue: queueName, jobName: job?.name, jobId: job?.id, ...errorSummary(error) },
      "job failed",
    ),
  );
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    await bounded(worker.waitUntilReady(), startupTimeoutMs);
  } catch (error) {
    await worker.close(true).catch(() => undefined);
    throw error;
  }
  void worker.run().catch((error) => {
    log.error(errorSummary(error), "worker run terminated");
    options.onFatal("run-failure");
  });

  let pressured = false;
  let checking = false;
  monitor = setInterval(() => {
    // Skip a tick while a previous check is in flight; a hung INFO must not stack calls.
    if (checking) return;
    checking = true;
    void bounded(readQueueRedisState(connection), 5000)
      .then((current) => {
        const check = checkQueuePolicy(current.policy, appEnv);
        if (!check.ok) {
          log.error({ queue: queueName }, check.message);
          if (check.fatal) options.onFatal("unsafe-queue-policy");
        }
        const ratio = memoryPressure(current);
        const high = ratio !== undefined && ratio >= MEMORY_WARN_RATIO;
        if (high && !pressured)
          log.warn({ memoryRatio: Number(ratio.toFixed(2)) }, "queue Redis memory pressure");
        pressured = high;
      })
      .catch((error) => log.warn(errorSummary(error), "queue Redis health check failed"))
      .finally(() => {
        checking = false;
      });
  }, options.monitorIntervalMs ?? 60_000);
  monitor.unref();

  log.info({ queue: queueName, concurrency }, "worker started");
  return {
    worker,
    async stop() {
      if (monitor) clearInterval(monitor);
      monitor = undefined;
      await worker.close();
    },
  };
}
