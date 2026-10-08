import { dueSlots, type ScheduleSpec } from "@ih/domain";
import { claimNextRun, completeRun, ensureSlots, failRun, type Database } from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import { setTimeout as delay } from "node:timers/promises";
import { bounded } from "./lifecycle";

export interface ScheduledJob {
  /** Unique job name, e.g. `reports.daily_summary`. */
  readonly name: string;
  readonly spec: ScheduleSpec;
  /**
   * Missed slots to run after downtime (1 = only the latest). A newly registered job also
   * back-fills this many slots on first deploy, so summaries/notifications should use 1.
   */
  readonly catchUp: number;
  readonly maxAttempts?: number;
  /**
   * Runs outside any transaction. Must be idempotent per slot (e.g. enqueue/emit keyed by job +
   * slot): a run that outlives its lease can be reclaimed and executed again.
   */
  run(slot: Date): Promise<void>;
}

export interface SchedulerOptions {
  readonly db: Database;
  readonly owner: string;
  readonly log: Logger;
  readonly jobs: readonly ScheduledJob[];
  readonly leaseMs?: number;
  readonly intervalMs?: number;
}

/**
 * Durable scheduler (architecture §8): every replica creates the due slots idempotently, then
 * leases runnable slots with SKIP LOCKED, so each (job, slot) runs once; missed slots inside the
 * catch-up window run after downtime; a crashed run is reclaimed after its lease expires.
 */
export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly leaseMs: number;
  private readonly runTimeoutMs: number;
  private readonly intervalMs: number;
  /** undefined = never started (direct tick() calls run); false = stopping. */
  private running: boolean | undefined;
  private loop: Promise<void> | undefined;
  private wake: AbortController | undefined;

  constructor(private readonly options: SchedulerOptions) {
    for (const job of options.jobs) {
      if (this.jobs.has(job.name)) throw new Error("Duplicate scheduled job");
      dueSlots(job.spec, new Date(), job.catchUp); // validates the spec up front
      this.jobs.set(job.name, job);
    }
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    // Stop waiting before the lease can expire under a still-running run.
    this.runTimeoutMs = Math.max(1000, Math.floor(this.leaseMs * 0.8));
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  async tick(now = new Date()): Promise<{ completed: number; failed: number }> {
    const { db, owner, log } = this.options;
    let completed = 0;
    let failed = 0;
    for (const job of this.jobs.values()) {
      await ensureSlots(db, job.name, dueSlots(job.spec, now, job.catchUp));
      const maxAttempts = job.maxAttempts ?? 3;
      // One slot at a time so each lease covers only the run that is about to execute.
      for (let i = 0; i < 20 && this.running !== false; i++) {
        const run = await claimNextRun(db, owner, job.name, this.leaseMs, maxAttempts);
        if (!run) break;
        const fields = { job: run.jobName, slot: run.slot.toISOString(), attempt: run.attempt };
        try {
          await bounded(job.run(run.slot), this.runTimeoutMs, "Scheduled run timed out");
        } catch (error) {
          if (error instanceof Error && error.message === "Scheduled run timed out") {
            // The work may still be running: leave the lease to expire rather than freeing the
            // slot now; a reclaim after expiry is the only possible repeat.
            log.error(fields, "scheduled run timed out; slot left to lease expiry");
            break;
          }
          const { errorCode } = errorSummary(error);
          const outcome = await failRun(db, owner, run.id, errorCode ?? "RUN_FAILED", {
            attempt: run.attempt,
            maxAttempts,
          });
          if (outcome === "failed") failed++;
          log.error({ ...fields, ...errorSummary(error), outcome }, "scheduled run failed");
          // Retry on a later tick, not immediately.
          break;
        }
        if (await completeRun(db, owner, run.id)) completed++;
        else log.warn(fields, "scheduled run lease lost before completion");
      }
    }
    return { completed, failed };
  }

  start(): void {
    if (this.running || this.jobs.size === 0) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (error) {
          this.options.log.error(errorSummary(error), "scheduler pass failed");
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
