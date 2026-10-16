import { PermanentEffectError, type EffectHandler } from "@ih/application";
import { EVENT_CATALOGUE, type EventType } from "@ih/contracts";
import { orderRollupDays, rollupDayIn, type Tx } from "@ih/db";
import type { Logger } from "@ih/logger";

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
