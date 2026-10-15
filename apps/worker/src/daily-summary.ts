import { dubaiDaily } from "@ih/domain";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

export const DAILY_SUMMARY_JOB = "reports.daily_summary";

/**
 * Daily summary slot, 09:00 Asia/Dubai (architecture §8 Scheduling; roadmap step 92, ADR 0060).
 * Registered now so each day has one durable slot across replicas; the summary itself needs the
 * daily rollups of step 106 and is wired there. Until then a run records its slot and sends
 * nothing: no invented figures. `catchUp: 1` means a deployment never replays old days.
 */
export function createDailySummaryJob(options: { log: Logger }): ScheduledJob {
  return {
    name: DAILY_SUMMARY_JOB,
    spec: dubaiDaily(9),
    catchUp: 1,
    async run(slot) {
      options.log.info(
        { job: DAILY_SUMMARY_JOB, slot: slot.toISOString(), outcome: "awaiting_analytics" },
        "daily summary not sent: report metrics arrive with analytics rollups",
      );
    },
  };
}
