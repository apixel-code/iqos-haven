import { dailySummaryTemplate, PermanentEffectError, type EmailPlanner } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import { emitDailySummary, loadDailySummaryEmail, rollupDay, type Database } from "@ih/db";
import {
  addDays,
  DUBAI_UTC_OFFSET_MINUTES,
  dubaiDaily,
  dubaiDate,
  fils,
  formatAed,
  TAX_NOTE,
} from "@ih/domain";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

export const DAILY_SUMMARY_JOB = "reports.daily_summary";

/**
 * Daily summary slot, 09:00 Asia/Dubai (architecture §8 Scheduling; ADR 0060, step 107 ADR 0073).
 * The run recomputes the previous Dubai day and writes one `report.daily_summary` event for it;
 * the email consumer decides recipients and sends. The event is unique per day, so a retried or
 * reclaimed slot sends nothing more. `catchUp: 1`: a deployment never replays old days.
 */
export function createDailySummaryJob(options: { db: Database; log: Logger }): ScheduledJob {
  return {
    name: DAILY_SUMMARY_JOB,
    spec: dubaiDaily(9),
    catchUp: 1,
    async run(slot) {
      const day = addDays(dubaiDate(slot), -1);
      await rollupDay(options.db, day);
      const { created } = await emitDailySummary(options.db, day);
      options.log.info(
        { job: DAILY_SUMMARY_JOB, slot: slot.toISOString(), day, created },
        "daily summary queued",
      );
    },
  };
}

/** Dubai wall-clock `YYYY-MM-DD HH:MM` of an instant. */
function dubaiTime(instant: Date): string {
  return new Date(instant.getTime() + DUBAI_UTC_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

/**
 * Email side of `report.daily_summary`. Recipients and figures are loaded at send time, so a
 * right revoked or the preference switched off before then means no email.
 */
export function dailySummaryEmailPlanner(db: Database, log: Logger): EmailPlanner {
  return async (context) => {
    const payload = EVENT_CATALOGUE["report.daily_summary"].payload.safeParse(context.payload);
    if (
      !payload.success ||
      context.schemaVersion !== 1 ||
      context.aggregateType !== "report" ||
      context.aggregateId !== payload.data.day
    )
      throw new PermanentEffectError("INVALID_REPORT_EVENT");
    const { day } = payload.data;
    const result = await loadDailySummaryEmail(db, day);
    if (result.outcome === "skipped") {
      log.info({ eventId: context.eventId, day, reason: result.reason }, "daily summary skipped");
      return null;
    }
    const { sales, topProducts } = result.content;
    const aed = (value: number) => formatAed(fils(value));
    return {
      template: dailySummaryTemplate,
      data: {
        day,
        booked: { orders: sales.bookedOrders, total: aed(sales.bookedTotalFils) },
        cancelled: { orders: sales.cancelledOrders },
        delivered: { orders: sales.deliveredOrders, total: aed(sales.deliveredTotalFils) },
        collected: { orders: sales.collectedOrders, amount: aed(sales.collectedFils) },
        computedAt: dubaiTime(sales.computedAt),
        taxNote: TAX_NOTE,
        topProducts,
      },
      recipients: result.recipients,
    };
  };
}
