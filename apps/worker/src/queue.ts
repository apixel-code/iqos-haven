import { Queue, type JobsOptions, type WorkerOptions } from "bullmq";
import Redis from "ioredis";
import { effectQueueName, type EffectJobData } from "./queues";

/**
 * Queue infrastructure shared by the worker and (from step 22) the relay. Jobs are disposable
 * copies of durable outbox/effect rows; the database decides completion and retries.
 */
export const QUEUE_PREFIX = "ih";

/** BullMQ blocking connections need `maxRetriesPerRequest: null`. */
export function createQueueConnection(url: string, connectTimeout = 5000): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, connectTimeout });
}

export function workerOptions(connection: Redis, concurrency: number): WorkerOptions {
  return {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency,
    autorun: false,
    // Stalled jobs are re-delivered once. A job still running at the 20 s shutdown deadline keeps
    // its lock until it expires; after a second stall BullMQ fails the job copy. That is safe only
    // because jobs are disposable: the reconciler re-enqueues unfinished DB effects (steps 22–24).
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  };
}

/**
 * Transport-level settings only. The retry/attempt budget of real work is owned by
 * `consumer_effects` (attempts, due_at, dead); Redis retention is bounded diagnostics.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

/** Producers must use this so jobs land under QUEUE_PREFIX, where the worker listens. */
export function createQueue(name: string, connection: Redis): Queue {
  return new Queue(name, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/** Redis side of the relay: one lazily created queue per consumer, stable job IDs. */
export class BullEffectEnqueuer {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly connection: Redis) {}

  async enqueue(data: EffectJobData, jobId: string, delayMs: number): Promise<void> {
    const name = effectQueueName(data.consumer);
    let queue = this.queues.get(name);
    if (!queue) {
      queue = createQueue(name, this.connection);
      this.queues.set(name, queue);
    }
    await queue.add(data.consumer, data, { jobId, ...(delayMs > 0 ? { delay: delayMs } : {}) });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
