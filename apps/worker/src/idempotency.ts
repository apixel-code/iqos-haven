import {
  clearExpiredConfirmationReplay,
  deleteExpiredIdempotencyRecords,
  type Database,
} from "@ih/db";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

const BATCH = 1000;
/**
 * Hourly cleanup of idempotency answers past their expiry (roadmap step 77, ADR 0043). An
 * order keeps its own key hash for good, so a cleaned-up key still can never place a second
 * order. Idempotent: it only deletes rows that are already expired, in bounded batches, and
 * whatever one run leaves is taken by the next.
 */
export function createIdempotencyCleanupJob(options: {
  db: Database;
  log: Logger;
  maxBatches?: number;
}): ScheduledJob {
  const { db, log } = options;
  return {
    name: "idempotency.cleanup",
    spec: { kind: "interval", everyMs: 60 * 60_000 },
    catchUp: 1,
    async run() {
      let deleted = 0;
      for (let batch = 0; batch < (options.maxBatches ?? 50); batch++) {
        const count = await deleteExpiredIdempotencyRecords(db, BATCH);
        deleted += count;
        if (count < BATCH) break;
      }
      log.info({ deleted }, "idempotency cleanup");
    },
  };
}

/** Separately encrypted material is erased within the next bounded cleanup pass after expiry. */
export function createConfirmationCleanupJob({
  db,
  log,
}: {
  db: Database;
  log: Logger;
}): ScheduledJob {
  return {
    name: "confirmation.cleanup",
    spec: { kind: "interval", everyMs: 60_000 },
    catchUp: 1,
    async run() {
      let cleared = 0;
      for (let batch = 0; batch < 50; batch++) {
        const count = await clearExpiredConfirmationReplay(db, BATCH);
        cleared += count;
        if (count < BATCH) break;
      }
      log.info({ cleared }, "confirmation replay cleanup");
    },
  };
}
