import { deleteExpiredBrowsingEvents, type Database } from "@ih/db";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

const BATCH = 5000;
/**
 * Daily removal of raw browsing events older than 90 days (roadmap step 103, ADR 0069; BI-08).
 * Bounded batches, idempotent: whatever one run leaves is taken by the next.
 */
export function createBrowsingEventsCleanupJob(options: {
  db: Database;
  log: Logger;
  maxBatches?: number;
}): ScheduledJob {
  const { db, log } = options;
  return {
    name: "analytics.events_cleanup",
    spec: { kind: "interval", everyMs: 24 * 60 * 60_000 },
    catchUp: 1,
    async run() {
      let deleted = 0;
      let backlog = true;
      for (let batch = 0; batch < (options.maxBatches ?? 40); batch++) {
        const count = await deleteExpiredBrowsingEvents(db, BATCH);
        deleted += count;
        if (count < BATCH) {
          backlog = false;
          break;
        }
      }
      if (backlog)
        log.warn({ deleted }, "browsing events cleanup left a backlog; next run continues");
      else log.info({ deleted }, "browsing events cleanup");
    },
  };
}
