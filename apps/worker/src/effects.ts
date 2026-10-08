import { PermanentEffectError, type EffectContext, type EffectHandler } from "@ih/application";
import { EVENT_CATALOGUE, effectJobId, type ConsumerName } from "@ih/contracts";
import {
  claimEffect,
  completeEffect,
  EffectLeaseLostError,
  heartbeatEffect,
  recordEffectFailure,
  type ClaimedEffectRun,
  type Database,
  type Tx,
} from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import { bounded } from "./lifecycle";
import { QUEUE_PREFIX, workerOptions } from "./queue";
import { effectQueueName, type EffectJobData } from "./queues";

export type EffectOutcome =
  | "completed"
  | "duplicate"
  | "retry"
  | "dead"
  | "lease_lost"
  /** The failure could not be recorded; the lease expires and the reconciler (step 24) recovers. */
  | "unrecorded";

/** Schedules the next attempt of a retried effect (Redis side; reconciler is the backstop). */
export interface RetryScheduler {
  enqueue(data: EffectJobData, jobId: string, delayMs: number): Promise<void>;
}

export interface EffectRunnerOptions {
  readonly db: Database;
  readonly owner: string;
  readonly log: Logger;
  readonly handlers: readonly EffectHandler<Tx>[];
  readonly retries?: RetryScheduler;
  readonly leaseMs?: number;
  readonly defaultMaxAttempts?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;
/** Added to retry job delays so a job never fires before the database-clock due_at. */
const RETRY_DELAY_MARGIN_MS = 1_000;
/** Completion after successful external work is retried briefly to avoid a duplicate send. */
const COMPLETION_ATTEMPTS = 3;

/**
 * Executes effects at least once with durable deduplication (architecture §8):
 * claim (lease) → database work + completion in one transaction, or external work with
 * heartbeats followed by receipt + completion. Duplicate jobs find nothing to claim.
 * Retries are owned by the effect row; the BullMQ job itself always succeeds once recorded.
 */
export class EffectRunner {
  private readonly handlers = new Map<string, EffectHandler<Tx>>();
  private readonly leaseMs: number;

  constructor(private readonly options: EffectRunnerOptions) {
    for (const handler of options.handlers) {
      if (this.handlers.has(handler.consumer)) throw new Error("Duplicate effect handler");
      this.handlers.set(handler.consumer, handler);
    }
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  consumers(): ConsumerName[] {
    return [...this.handlers.keys()] as ConsumerName[];
  }

  async run(data: EffectJobData): Promise<EffectOutcome> {
    const { db, owner, log } = this.options;
    const handler = this.handlers.get(data.consumer);
    // Never claim work this process cannot do; the effect stays for a capable runner.
    if (!handler) throw new Error("No handler registered for consumer");
    const maxAttempts =
      handler.maxAttempts ?? this.options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const claimed = await claimEffect(
      db,
      owner,
      data.effectId,
      data.consumer,
      this.leaseMs,
      maxAttempts,
    );
    if (!claimed) return "duplicate";
    const context = toContext(claimed, data.consumer);
    const fields = {
      eventId: claimed.eventId,
      effectId: claimed.effectId,
      consumer: data.consumer,
      attempt: claimed.attempt,
    };
    let receipt: string | undefined;
    try {
      if (handler.kind === "database") {
        await completeEffect(db, owner, claimed.effectId, (tx) => handler.apply(tx, context));
      } else {
        const result = await this.withHeartbeat(claimed.effectId, (signal) =>
          handler.perform(context, signal),
        );
        receipt = result.receipt?.slice(0, 256);
        await this.completeAfterExternal(claimed.effectId, receipt);
      }
      log.info(fields, "effect completed");
      return "completed";
    } catch (error) {
      if (error instanceof EffectLeaseLostError) {
        log.warn(fields, "effect lease lost; another runner owns it");
        return "lease_lost";
      }
      const permanent = error instanceof PermanentEffectError;
      const code = permanent ? error.code : safeCode(error);
      let decision;
      try {
        decision = await recordEffectFailure(db, owner, claimed.effectId, code, {
          permanent,
          attempt: claimed.attempt,
          maxAttempts,
          ...(receipt ? { receipt } : {}),
        });
      } catch (recordError) {
        // The job is acknowledged; the effect stays running until its lease expires and the
        // reconciler (step 24) re-enqueues it. Rethrowing would only produce a duplicate job.
        log.error({ ...fields, ...errorSummary(recordError) }, "effect failure not recorded");
        return "unrecorded";
      }
      if (!decision) {
        log.warn(fields, "effect lease lost while recording failure");
        return "lease_lost";
      }
      if (decision.status === "dead") {
        log.error({ ...fields, errorCode: code }, "effect dead; needs investigation");
        return "dead";
      }
      log.warn({ ...fields, errorCode: code }, "effect failed; retry scheduled");
      // Best effort: if this enqueue is lost, the reconciler (step 24) re-enqueues due retries.
      await this.options.retries
        ?.enqueue(
          data,
          effectJobId(claimed.eventId, data.consumer) + ":retry:" + claimed.attempt,
          (decision.delayMs ?? 0) + RETRY_DELAY_MARGIN_MS,
        )
        .catch((scheduleError) =>
          log.warn({ ...fields, ...errorSummary(scheduleError) }, "retry enqueue failed"),
        );
      return "retry";
    }
  }

  /**
   * The external call already happened: retry the completion briefly on transient database
   * errors, because failing here schedules a repeat of the external call.
   */
  private async completeAfterExternal(effectId: string, receipt: string | undefined) {
    const { db, owner } = this.options;
    for (let attempt = 1; ; attempt++) {
      try {
        await completeEffect(db, owner, effectId, async () => undefined, receipt);
        return;
      } catch (error) {
        if (error instanceof EffectLeaseLostError || attempt >= COMPLETION_ATTEMPTS) throw error;
        await delay(200 * attempt);
      }
    }
  }

  /**
   * Renews the lease every third of its length. Aborts the work if the lease is lost or if
   * heartbeats keep failing long enough that another runner could reclaim it.
   */
  private async withHeartbeat<T>(
    effectId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { db, owner } = this.options;
    const controller = new AbortController();
    const interval = Math.max(1000, Math.floor(this.leaseMs / 3));
    let lost = false;
    let lastRenewal = Date.now();
    const timer = setInterval(() => {
      void bounded(heartbeatEffect(db, owner, effectId, this.leaseMs), interval)
        .then((alive) => {
          if (alive) lastRenewal = Date.now();
          else lost = true;
        })
        .catch(() => undefined)
        .finally(() => {
          if (!lost && Date.now() - lastRenewal >= (this.leaseMs * 2) / 3) lost = true;
          if (lost) controller.abort();
        });
    }, interval);
    try {
      const result = await work(controller.signal);
      if (lost) throw new EffectLeaseLostError("Effect lease lost during external work");
      return result;
    } finally {
      clearInterval(timer);
    }
  }
}

function toContext(claimed: ClaimedEffectRun, consumer: ConsumerName): EffectContext {
  return {
    eventId: claimed.eventId,
    effectId: claimed.effectId,
    consumer,
    eventType: claimed.eventType,
    schemaVersion: claimed.schemaVersion,
    aggregateType: claimed.aggregateType,
    aggregateId: claimed.aggregateId,
    payload: claimed.payload,
    attempt: claimed.attempt,
  };
}

/** Only a bounded, code-like token is persisted; messages may echo SQL or payload data. */
function safeCode(error: unknown): string {
  const { errorCode } = errorSummary(error);
  return errorCode ? "TRANSIENT:" + errorCode : "TRANSIENT";
}

/** The synthetic probe consumer (Milestone 2 gate): validates the event, writes nothing else. */
export const systemProbeHandler: EffectHandler<Tx> = {
  kind: "database",
  consumer: "system_probe",
  maxAttempts: 3,
  async apply(_tx, context) {
    if (context.eventType !== "system.probe")
      throw new PermanentEffectError("UNEXPECTED_EVENT_TYPE");
    if (!EVENT_CATALOGUE["system.probe"].payload.safeParse(context.payload).success)
      throw new PermanentEffectError("INVALID_PAYLOAD");
  },
};

/** One BullMQ worker per handled consumer queue, sharing the runner. */
export function startEffectWorkers(
  runner: EffectRunner,
  connection: Redis,
  concurrency: number,
  log: Logger,
  prefix = QUEUE_PREFIX,
): { stop(): Promise<void> } {
  const workers = runner.consumers().map((consumer) => {
    const worker = new Worker(
      effectQueueName(consumer),
      (job: Job<EffectJobData>) => runner.run(job.data),
      workerOptions(connection, concurrency, prefix),
    );
    worker.on("error", (error) => log.error(errorSummary(error), "effect worker error"));
    worker.on("failed", (job, error) =>
      log.error({ consumer, jobId: job?.id, ...errorSummary(error) }, "effect job failed"),
    );
    void worker.run().catch((error) => log.error(errorSummary(error), "effect worker stopped"));
    return worker;
  });
  return {
    async stop() {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
