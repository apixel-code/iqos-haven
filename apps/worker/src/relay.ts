import { CONSUMERS, effectJobId, type ConsumerName } from "@ih/contracts";
import {
  claimDueEvents,
  markDispatched,
  recordDispatchFailure,
  type ClaimedEvent,
  type Database,
} from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { setTimeout as delay } from "node:timers/promises";
import { bounded } from "./lifecycle";
import type { EffectJobData } from "./queues";

/** Enqueue port: the Redis side of dispatch. Runs only outside database transactions. */
export interface EffectEnqueuer {
  enqueue(data: EffectJobData, jobId: string, delayMs: number): Promise<void>;
}

export interface RelayOptions {
  readonly db: Database;
  readonly enqueuer: EffectEnqueuer;
  readonly owner: string;
  readonly log: Logger;
  readonly batchSize?: number;
  /** Short lease: a crashed relay's events become claimable again after this. */
  readonly leaseMs?: number;
  readonly pollMs?: number;
}

/** A Redis call that hangs must not stall the loop or shutdown (BullMQ retries forever). */
const ENQUEUE_TIMEOUT_MS = 5_000;
/** Stop dispatching a batch this long before its lease expires; the rest is reclaimed later. */
const LEASE_MARGIN_MS = 5_000;

const isConsumer = (value: string): value is ConsumerName =>
  (CONSUMERS as readonly string[]).includes(value);

/**
 * Leased outbox relay (architecture §8): claim (short tx) → enqueue (no tx) → mark (short tx).
 * Crash or lost lease between the steps only causes a duplicate job with the same stable job ID,
 * which BullMQ deduplicates while the job exists and the effect row deduplicates afterwards.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: AbortController | undefined;

  constructor(private readonly options: RelayOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollMs = options.pollMs ?? 1_000;
  }

  /** One relay pass: events claimed, and how many of them were marked dispatched. */
  async tick(): Promise<{ claimed: number; dispatched: number }> {
    const { db, owner } = this.options;
    const leaseDeadline = Date.now() + this.leaseMs - LEASE_MARGIN_MS;
    const events = await claimDueEvents(db, owner, this.batchSize, this.leaseMs);
    let dispatched = 0;
    for (const event of events) {
      // Past the margin another relay may reclaim; leave the rest to lease expiry.
      if (Date.now() > leaseDeadline) break;
      if (await this.dispatch(event)) dispatched++;
    }
    return { claimed: events.length, dispatched };
  }

  private async dispatch(event: ClaimedEvent): Promise<boolean> {
    const { db, owner, enqueuer, log } = this.options;
    try {
      for (const effect of event.effects) {
        if (!isConsumer(effect.consumer)) throw new UnknownConsumerError();
        await bounded(
          enqueuer.enqueue(
            { eventId: event.id, effectId: effect.id, consumer: effect.consumer },
            effectJobId(event.id, effect.consumer),
            Math.max(0, effect.dueAt.getTime() - Date.now()),
          ),
          ENQUEUE_TIMEOUT_MS,
        );
      }
    } catch (error) {
      const unknown = error instanceof UnknownConsumerError;
      const code = unknown ? error.code : "ENQUEUE_FAILED";
      const fields = { eventId: event.id, attempt: event.dispatchAttempts, ...errorSummary(error) };
      // An unknown consumer is a deployment/catalogue mismatch, not a transient failure.
      if (unknown) log.error(fields, "outbox effect has no known consumer");
      else log.warn(fields, "outbox dispatch failed");
      await recordDispatchFailure(db, owner, event.id, code, event.dispatchAttempts);
      return false;
    }
    const marked = await markDispatched(
      db,
      owner,
      event.id,
      event.effects.map((effect) => effect.id),
    );
    if (!marked) log.warn({ eventId: event.id }, "outbox lease lost before dispatch mark");
    return marked;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let claimed = 0;
        try {
          ({ claimed } = await this.tick());
        } catch (error) {
          this.options.log.error(errorSummary(error), "outbox relay pass failed");
        }
        // A full batch means more may be waiting; otherwise idle until the next poll.
        // Failed dispatches keep a backoff lease, so a full batch of failures cannot hot-loop.
        if (claimed < this.batchSize && this.running) {
          this.wake = new AbortController();
          await delay(this.pollMs, undefined, { signal: this.wake.signal }).catch(() => undefined);
        }
      }
    })();
  }

  /** Stops after the current pass; never abandons a claim halfway through marking. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.abort();
    await this.loop;
  }
}

class UnknownConsumerError extends Error {
  readonly code = "UNKNOWN_CONSUMER";
}
