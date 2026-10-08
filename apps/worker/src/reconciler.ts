import { CONSUMERS, effectReconcileJobId, type ConsumerName } from "@ih/contracts";
import { completeFinishedEvents, findStrandedEffects, markRequeued, type Database } from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { setTimeout as delay } from "node:timers/promises";
import { bounded } from "./lifecycle";
import type { EffectEnqueuer } from "./relay";

export interface ReconcilerOptions {
  readonly db: Database;
  readonly enqueuer: EffectEnqueuer;
  readonly log: Logger;
  /** Queued/retry work older than this without progress is considered lost from Redis. */
  readonly staleMs?: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
}

const isConsumer = (value: string): value is ConsumerName =>
  (CONSUMERS as readonly string[]).includes(value);

/**
 * Rebuilds queue state from unfinished database effects (architecture §8: Redis loss, crashed
 * runners, lost retry jobs). Job IDs carry a time bucket: replicas reconciling in the same
 * bucket deduplicate, and an older job copy that finished as a no-op cannot block a new one.
 * Live leases are never re-enqueued; any extra job finds nothing to claim.
 */
export class EffectReconciler {
  private readonly staleMs: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  /** undefined = never started (direct tick() calls run); false = stopping. */
  private running: boolean | undefined;
  private loop: Promise<void> | undefined;
  private wake: AbortController | undefined;

  constructor(private readonly options: ReconcilerOptions) {
    this.staleMs = options.staleMs ?? 5 * 60_000;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 200;
  }

  async tick(now = Date.now()): Promise<{ requeued: number; eventsCompleted: number }> {
    const { db, enqueuer, log } = this.options;
    const stranded = await findStrandedEffects(db, this.staleMs, this.batchSize);
    const bucket = Math.floor(now / this.staleMs);
    const requeued: string[] = [];
    for (const effect of stranded) {
      // Stop promptly on shutdown.
      if (this.running === false) break;
      if (!isConsumer(effect.consumer)) {
        log.error({ effectId: effect.effectId }, "stranded effect has no known consumer");
        continue;
      }
      try {
        await bounded(
          enqueuer.enqueue(
            { eventId: effect.eventId, effectId: effect.effectId, consumer: effect.consumer },
            effectReconcileJobId(effect.eventId, effect.consumer, bucket),
            0,
          ),
          5_000,
        );
        requeued.push(effect.effectId);
      } catch (error) {
        // Redis is likely unavailable: end this pass instead of timing out on every effect.
        log.warn({ effectId: effect.effectId, ...errorSummary(error) }, "reconcile enqueue failed");
        break;
      }
    }
    await markRequeued(db, requeued);
    const eventsCompleted = await completeFinishedEvents(db, this.batchSize);
    if (requeued.length || eventsCompleted)
      log.info({ requeued: requeued.length, eventsCompleted }, "reconciler recovered work");
    return { requeued: requeued.length, eventsCompleted };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          this.options.log.error(errorSummary(error), "reconciler pass failed");
        }
        if (!this.running) break;
        this.wake = new AbortController();
        await delay(this.intervalMs, undefined, { signal: this.wake.signal }).catch(
          () => undefined,
        );
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.abort();
    await this.loop;
  }
}
