import {
  lowStockTemplate,
  PermanentEffectError,
  type EffectContext,
  type EmailPlanner,
} from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import { loadLowStockEmail, writeLowStockNotification, type Database, type Tx } from "@ih/db";
import type { Logger } from "@ih/logger";

/** The variant an `inventory.low` event is about, or a permanent failure for anything else. */
function lowStockVariantId(context: EffectContext): string {
  const payload = EVENT_CATALOGUE["inventory.low"].payload.safeParse(context.payload);
  if (!payload.success || context.schemaVersion !== 1 || context.aggregateType !== "variant")
    throw new PermanentEffectError("INVALID_INVENTORY_EVENT");
  if (context.aggregateId !== payload.data.variantId)
    throw new PermanentEffectError("INVALID_INVENTORY_EVENT");
  return payload.data.variantId;
}
/**
 * Inbox side of a low-stock crossing (roadmap step 92, ADR 0060). The notification, its
 * receipts, the quiet-window claim and the effect's completion commit together.
 */
export async function applyLowStockNotification(
  tx: Tx,
  context: EffectContext,
  log: Logger,
): Promise<void> {
  const variantId = lowStockVariantId(context);
  const result = await writeLowStockNotification(tx, { eventId: context.eventId, variantId });
  // Variants are never deleted: an event without its variant is a fault to look at, not retry.
  if (result.outcome === "variant_missing") throw new PermanentEffectError("VARIANT_NOT_FOUND");
  log.info(
    {
      eventId: context.eventId,
      outcome: result.outcome,
      ...(result.outcome === "written" ? { receipts: result.receipts } : {}),
    },
    "low-stock notification",
  );
}
/**
 * Low-stock email to the Settings recipients, while it is switched on. Anything that is no
 * longer worth an alert, or falls inside the quiet window, completes without sending.
 */
export function lowStockEmailPlanner(db: Database, log: Logger): EmailPlanner {
  return async (context) => {
    const result = await loadLowStockEmail(db, {
      eventId: context.eventId,
      variantId: lowStockVariantId(context),
    });
    if (result.outcome === "variant_missing") throw new PermanentEffectError("VARIANT_NOT_FOUND");
    if (result.outcome === "skipped") {
      log.info({ eventId: context.eventId, reason: result.reason }, "low-stock email skipped");
      return null;
    }
    const { productName, sku, stock, threshold } = result.summary;
    return {
      template: lowStockTemplate,
      data: { productName, sku, stock, threshold },
      recipients: result.recipients,
    };
  };
}
