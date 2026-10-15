import { PermanentEffectError, type EffectContext } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import { writeReviewNotification, type Tx } from "@ih/db";
import type { Logger } from "@ih/logger";

/**
 * Inbox side of a submitted review (roadmap step 94, ADR 0062). The notification, its receipts
 * for the moderators and the effect's completion commit together.
 */
export async function applyReviewNotification(
  tx: Tx,
  context: EffectContext,
  log: Logger,
): Promise<void> {
  const payload = EVENT_CATALOGUE["review.submitted"].payload.safeParse(context.payload);
  if (
    !payload.success ||
    context.schemaVersion !== 1 ||
    context.aggregateType !== "review" ||
    context.aggregateId !== payload.data.reviewId
  )
    throw new PermanentEffectError("INVALID_REVIEW_EVENT");
  const result = await writeReviewNotification(tx, {
    eventId: context.eventId,
    reviewId: payload.data.reviewId,
  });
  // Reviews are never deleted: an event without its review is a fault to look at, not retry.
  if (result.outcome === "review_missing") throw new PermanentEffectError("REVIEW_NOT_FOUND");
  log.info(
    {
      eventId: context.eventId,
      outcome: result.outcome,
      ...(result.outcome === "written" ? { receipts: result.receipts } : {}),
    },
    "review notification",
  );
}
