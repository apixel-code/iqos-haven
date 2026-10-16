import { PermanentEffectError, type EffectHandler } from "@ih/application";
import { EVENT_CATALOGUE, type EventType } from "@ih/contracts";
import { orderRollupDays, rollupDay, rollupDayIn, type Database, type Tx } from "@ih/db";
import { addDays, dubaiDaily, dubaiDate } from "@ih/domain";
import type { Logger } from "@ih/logger";
import type { ScheduledJob } from "./scheduler";

/** Order events that change a day's figures (step 106, ADR 0072). */
export const ROLLUP_EVENT_TYPES = [
  "order.created",
  "order.updated",
  "order.status_changed",
  "order.cancelled",
  "order.collection_recorded",
  "order.collection_corrected",
] as const satisfies readonly EventType[];

/**
 * Analytics consumer (roadmap step 106, ADR 0072): an order event recomputes the sales and
 * product rows of every Dubai day the order touches (placed, delivered, each collection
 * record), inside the effect's transaction. Recomputing replaces rows, so a redelivered event
 * changes nothing; days are taken in date order, so two effects never wait on each other in a
 * cycle.
 */
export function createAnalyticsRollupConsumer(options: { log: Logger }): EffectHandler<Tx> {
  return {
    kind: "database",
    consumer: "analytics_rollup",
    async apply(tx, context) {
      const type = context.eventType as (typeof ROLLUP_EVENT_TYPES)[number];
      if (!(ROLLUP_EVENT_TYPES as readonly string[]).includes(type))
        throw new PermanentEffectError("UNEXPECTED_EVENT_TYPE");
      const payload = EVENT_CATALOGUE[type].payload.safeParse(context.payload);
      if (!payload.success || context.aggregateType !== "order")
        throw new PermanentEffectError("INVALID_ORDER_EVENT");
      const days = await orderRollupDays(tx, payload.data.orderId);
      // Orders are never deleted: an event without its order is a fault to look at.
      if (!days.length) throw new PermanentEffectError("ORDER_NOT_FOUND");
      for (const day of days) await rollupDayIn(tx, day, ["sales", "products"]);
      options.log.info({ eventId: context.eventId, days: days.length }, "analytics rollup");
    },
  };
}

/** Days the late-edit pass recomputes each night, counted back from yesterday. */
export const LATE_EDIT_DAYS = 7;

/**
 * Today's freshness (step 107, ADR 0073): every 10 minutes, today and yesterday are recomputed
 * whole (sales, products, search, saved lists). Yesterday is included so its last minutes are
 * counted once the day has closed. Recomputing replaces rows, so a repeated slot adds nothing.
 */
export function createTodayRollupJob(options: { db: Database; log: Logger }): ScheduledJob {
  return {
    name: "analytics.rollup_today",
    spec: { kind: "interval", everyMs: 10 * 60_000 },
    catchUp: 1,
    async run(slot) {
      const today = dubaiDate(slot);
      for (const day of [addDays(today, -1), today]) await rollupDay(options.db, day);
      options.log.info({ day: today }, "today's rollup");
    },
  };
}

/**
 * Late edits (step 107, ADR 0073): at 03:00 Dubai the seven days before today are recomputed,
 * which also covers orders whose events predate the analytics consumer and any effect that
 * died. Older days are only recomputed by the controlled backfill (`pnpm analytics:backfill`).
 */
export function createLateEditRollupJob(options: { db: Database; log: Logger }): ScheduledJob {
  return {
    name: "analytics.rollup_recent",
    spec: dubaiDaily(3),
    catchUp: 1,
    async run(slot) {
      const today = dubaiDate(slot);
      for (let back = LATE_EDIT_DAYS; back >= 1; back--)
        await rollupDay(options.db, addDays(today, -back));
      options.log.info({ days: LATE_EDIT_DAYS, until: addDays(today, -1) }, "recent days rollup");
    },
  };
}
