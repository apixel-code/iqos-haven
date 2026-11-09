import {
  newOrderTemplate,
  orderConfirmationTemplate,
  PermanentEffectError,
  type EffectContext,
  type EffectHandler,
  type EmailPlanner,
} from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import {
  loadCustomerOrderEmail,
  loadNewOrderEmail,
  writeNewOrderNotification,
  type Database,
  type OrderEmailItem,
  type Tx,
} from "@ih/db";
import { fils, formatAed } from "@ih/domain";
import type { Logger } from "@ih/logger";
import { applyLowStockNotification } from "./low-stock-notifications";
import { applyReviewNotification } from "./review-notifications";

/** The order an `order.created` event is about, or a permanent failure for anything else. */
function createdOrderId(context: EffectContext): string {
  const payload = EVENT_CATALOGUE["order.created"].payload.safeParse(context.payload);
  if (!payload.success || context.schemaVersion !== 1 || context.aggregateType !== "order")
    throw new PermanentEffectError("INVALID_ORDER_EVENT");
  if (context.aggregateId !== payload.data.orderId)
    throw new PermanentEffectError("INVALID_ORDER_EVENT");
  return payload.data.orderId;
}
/**
 * Inbox consumer (roadmap step 78, ADR 0047; low stock: step 92, ADR 0060; reviews: step 94,
 * ADR 0062). The notification, its receipts and the effect's completion commit together, so a
 * redelivered event writes nothing twice.
 */
export function createNotificationConsumer(options: { log: Logger }): EffectHandler<Tx> {
  return {
    kind: "database",
    consumer: "notification",
    async apply(tx, context) {
      if (context.eventType === "inventory.low")
        return applyLowStockNotification(tx, context, options.log);
      if (context.eventType === "review.submitted")
        return applyReviewNotification(tx, context, options.log);
      if (context.eventType !== "order.created")
        throw new PermanentEffectError("UNEXPECTED_EVENT_TYPE");
      const orderId = createdOrderId(context);
      const result = await writeNewOrderNotification(tx, { eventId: context.eventId, orderId });
      // Orders are never deleted: an event without its order is a fault to look at, not retry.
      if (result.outcome === "order_missing") throw new PermanentEffectError("ORDER_NOT_FOUND");
      options.log.info(
        {
          eventId: context.eventId,
          outcome: result.outcome,
          ...(result.outcome === "written" ? { receipts: result.receipts } : {}),
        },
        "new-order notification",
      );
    },
  };
}
/** One order line as both order emails show it: "TEREA UAE · silver × 2" and its total. */
const itemLine = (item: OrderEmailItem) => ({
  label: `${item.name}${item.options ? " · " + item.options : ""} × ${item.quantity}`.slice(0, 400),
  total: formatAed(fils(item.totalFils)),
});
/** New-order email to the addresses in Settings; no recipients completes without sending. */
export function newOrderEmailPlanner(db: Database): EmailPlanner {
  return async (context) => {
    const loaded = await loadNewOrderEmail(db, createdOrderId(context));
    if (!loaded) throw new PermanentEffectError("ORDER_NOT_FOUND");
    const { order, contact, items, recipients, paymentMethod } = loaded;
    return {
      template: newOrderTemplate,
      data: {
        orderNumber: order.orderNumber,
        total: formatAed(fils(order.totalFils)),
        units: order.units,
        areaName: order.areaName,
        paymentMethod,
        customer: { name: contact.name, phone: contact.phone, email: contact.email },
        items: items.map(itemLine),
      },
      recipients,
    };
  };
}

/** The order an `order.confirmation_requested` event is about (ADR 0102). */
function confirmationOrderId(context: EffectContext): string {
  const payload = EVENT_CATALOGUE["order.confirmation_requested"].payload.safeParse(
    context.payload,
  );
  if (!payload.success || context.schemaVersion !== 1 || context.aggregateType !== "order")
    throw new PermanentEffectError("INVALID_ORDER_EVENT");
  if (context.aggregateId !== payload.data.orderId)
    throw new PermanentEffectError("INVALID_ORDER_EVENT");
  return payload.data.orderId;
}
/** The shopper's order confirmation, to the email given at checkout (ADR 0102). */
export function customerOrderEmailPlanner(db: Database): EmailPlanner {
  return async (context) => {
    const loaded = await loadCustomerOrderEmail(db, confirmationOrderId(context));
    if (!loaded) throw new PermanentEffectError("ORDER_NOT_FOUND");
    if (!loaded.email) return null;
    const aed = (value: number) => formatAed(fils(value));
    const digits = loaded.store.whatsappNumber?.replace(/\D/gu, "");
    return {
      template: orderConfirmationTemplate,
      data: {
        firstName: loaded.customerName.split(" ")[0]!.slice(0, 100),
        orderNumber: loaded.orderNumber,
        customer: { name: loaded.customerName, phone: loaded.phone, email: loaded.email },
        items: loaded.items.map(itemLine),
        subtotal: aed(loaded.merchandiseSubtotalFils),
        discount: loaded.discountFils > 0 ? aed(loaded.discountFils) : null,
        delivery: aed(loaded.deliveryFeeFils),
        total: aed(loaded.totalFils),
        areaName: loaded.areaName,
        eta: loaded.deliveryEtaText,
        paymentMethod: loaded.paymentMethod,
        whatsappUrl: digits ? `https://wa.me/${digits}` : null,
        trackUrl: loaded.store.domain ? `https://${loaded.store.domain}/track` : null,
      },
      recipients: [loaded.email],
    };
  };
}
