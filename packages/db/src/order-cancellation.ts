import {
  defineEvent,
  orderCancelRequestSchema,
  orderCancelResponseSchema,
  type ConflictCode,
  type OrderCancelRequest,
  type OrderCancelResponse,
} from "@ih/contracts";
import type { OrderStatus } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { releaseCouponRedemption } from "./coupons";
import { canonicalPayloadHash } from "./idempotency";
import { publishLowStockCrossing } from "./inventory";
import { lockOrder, lockVariantsForStock, OrderNotFoundError } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/**
 * Order cancellation (roadmap step 86, ADR 0054). One transaction: the actor's rights, the
 * permanent command record, the order lock, the coupon use released, the variants locked and
 * stock returned through the ledger, the order cancelled with its reason, the history row, the
 * audit entry and `order.cancelled`. All of it commits or none of it does.
 *
 * - Pending, Confirmed, Processing: `orders.cancel_before_dispatch`; every unit the order still
 *   holds (after any edits) goes back to stock.
 * - Out for Delivery: also `orders.cancel_after_dispatch` (Owner); the goods have come back and
 *   every line is classified; only resellable units go back, damaged ones are recorded.
 * - Delivered or Cancelled: refused.
 */
export class OrderCancelForbiddenError extends Error {}
export class OrderCancelNotFoundError extends Error {}
/** The request does not fit the order's state (a return list where none belongs). */
export class OrderCancelInvalidError extends Error {}
export class OrderCancelConflictError extends Error {
  constructor(
    readonly reason: Extract<
      ConflictCode,
      "VERSION_CONFLICT" | "COMMAND_REUSED" | "ORDER_NOT_CANCELLABLE" | "RETURN_INCOMPLETE"
    >,
  ) {
    super(reason);
  }
}

interface Record_ {
  orderId: string;
  commandId: string;
  actorId: string;
  actorName: string;
  kind: "before_handoff" | "returned";
  fromStatus: OrderStatus;
  requestHash: Buffer;
  orderVersion: number;
  couponReleased: boolean;
  createdAt: Date;
  reason: string;
}
async function existing(tx: Database | Tx, commandId: string): Promise<Record_ | null> {
  const [row] = await tx.$queryRaw<Record_[]>(Prisma.sql`
    SELECT c.order_id AS "orderId", c.command_id::text AS "commandId", c.actor_id AS "actorId",
      u.name AS "actorName", c.kind, c.from_status AS "fromStatus",
      c.request_hash AS "requestHash", c.order_version AS "orderVersion",
      c.coupon_released AS "couponReleased", c.created_at AS "createdAt",
      o.cancel_reason AS reason
    FROM order_cancellations c
    JOIN staff_users u ON u.id=c.actor_id JOIN orders o ON o.id=c.order_id
    WHERE c.command_id=${commandId}::uuid`);
  return row ?? null;
}
const same = (row: Record_, actorId: string | null, orderId: string, hash: Buffer) =>
  row.actorId === actorId && row.orderId === orderId && Buffer.from(row.requestHash).equals(hash);

/** The answer for a cancellation, rebuilt from what was written: the same on every replay. */
async function receipt(tx: Database | Tx, row: Record_, replayed: boolean) {
  const restocked = await tx.$queryRaw<Array<{ sku: string; quantity: number }>>(Prisma.sql`
    SELECT v.sku, m.delta AS quantity FROM stock_movements m JOIN variants v ON v.id=m.variant_id
    WHERE m.order_id=${row.orderId}::uuid AND m.reason IN ('ORDER_CANCEL','ORDER_RETURN')
    ORDER BY v.sku`);
  const damaged = await tx.$queryRaw<Array<{ sku: string; quantity: number }>>(Prisma.sql`
    SELECT sku, damaged_quantity AS quantity FROM order_return_items
    WHERE order_id=${row.orderId}::uuid AND damaged_quantity > 0 ORDER BY sku`);
  return orderCancelResponseSchema.parse({
    orderId: row.orderId,
    kind: row.kind,
    fromStatus: row.fromStatus,
    orderVersion: row.orderVersion,
    reason: row.reason,
    cancelledAt: row.createdAt.toISOString(),
    actor: { id: row.actorId, name: row.actorName },
    restocked,
    damaged,
    couponReleased: row.couponReleased,
    replayed,
  });
}
function dbCode(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}
async function holds(tx: Tx, actorId: string | null, key: "orders.cancel_after_dispatch") {
  try {
    await lockCatalogueActor(tx, actorId, [key], false);
    return true;
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) return false;
    throw error;
  }
}

export async function cancelOrder(
  db: Database,
  context: CommandContext,
  orderId: string,
  request: OrderCancelRequest,
): Promise<OrderCancelResponse> {
  const parsed = orderCancelRequestSchema.parse(request);
  // One spelling of each variant ID, so the same return list is always the same request.
  const input = {
    ...parsed,
    ...(parsed.returnItems && {
      returnItems: parsed.returnItems.map((item) => ({
        ...item,
        variantId: item.variantId.toLowerCase(),
      })),
    }),
  };
  // What makes two requests the same command. The return list is compared in variant order.
  const hash = canonicalPayloadHash({
    ...input,
    returnItems: input.returnItems
      ? [...input.returnItems].sort((a, b) => a.variantId.localeCompare(b.variantId))
      : null,
  });
  const run = () =>
    withTransaction(db, async (tx) => {
      try {
        await lockCatalogueActor(tx, context.actorId, ["orders.cancel_before_dispatch"], true);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new OrderCancelForbiddenError();
        throw error;
      }
      const early = await existing(tx, input.commandId);
      if (early) {
        if (!same(early, context.actorId, orderId, hash))
          throw new OrderCancelConflictError("COMMAND_REUSED");
        return receipt(tx, early, true);
      }
      let order;
      try {
        order = await lockOrder(tx, orderId);
      } catch (error) {
        if (error instanceof OrderNotFoundError) throw new OrderCancelNotFoundError();
        throw error;
      }
      const raced = await existing(tx, input.commandId);
      if (raced) {
        if (!same(raced, context.actorId, orderId, hash))
          throw new OrderCancelConflictError("COMMAND_REUSED");
        return receipt(tx, raced, true);
      }
      if (order.version !== input.expectedVersion)
        throw new OrderCancelConflictError("VERSION_CONFLICT");
      const status = order.status as OrderStatus;
      if (status === "delivered" || status === "cancelled")
        throw new OrderCancelConflictError("ORDER_NOT_CANCELLABLE");
      const returned = status === "out_for_delivery";
      if (returned && !(await holds(tx, context.actorId, "orders.cancel_after_dispatch")))
        throw new OrderCancelForbiddenError();
      if (!returned && input.returnItems) throw new OrderCancelInvalidError();

      // What the order holds now, after any edits: exactly what was taken from stock for it.
      const lines = await tx.$queryRaw<Array<{ variantId: string; sku: string; quantity: number }>>(
        Prisma.sql`SELECT variant_id AS "variantId", sku, quantity FROM order_items
          WHERE order_id=${orderId}::uuid ORDER BY variant_id`,
      );
      const back = new Map(lines.map((line) => [line.variantId, line.quantity]));
      if (returned) {
        const given = input.returnItems ?? [];
        const classified = new Map(given.map((item) => [item.variantId.toLowerCase(), item]));
        const complete =
          given.length === lines.length &&
          classified.size === lines.length &&
          lines.every((line) => {
            const item = classified.get(line.variantId);
            return item && item.resellableQuantity + item.damagedQuantity === line.quantity;
          });
        if (!complete) throw new OrderCancelConflictError("RETURN_INCOMPLETE");
        for (const line of lines)
          back.set(line.variantId, classified.get(line.variantId)!.resellableQuantity);
      }

      // Lock order: order (held) → coupon → variants, as every order command does.
      const couponReleased = await releaseCouponRedemption(tx, orderId);
      const variants = await lockVariantsForStock(
        tx,
        lines.map((line) => line.variantId),
      );
      const reason = returned ? "ORDER_RETURN" : "ORDER_CANCEL";
      const command = `${returned ? "return" : "cancel"}:${orderId}`;
      for (const variant of variants) {
        const quantity = back.get(variant.variantId) ?? 0;
        if (quantity <= 0) continue;
        const after = variant.stockOnHand + quantity;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id,
            effect, actor_id, order_id)
          VALUES (${variant.variantId}::uuid, ${quantity}, ${after}, ${reason}, ${command},
            ${returned ? "order_return" : "order_cancel"}, ${context.actorId}::uuid,
            ${orderId}::uuid)`);
        await publishLowStockCrossing(
          tx,
          variant.variantId,
          "stock",
          { stock: variant.stockOnHand, threshold: variant.lowStockThreshold },
          { stock: after, threshold: variant.lowStockThreshold },
        );
      }

      const [updated] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
        UPDATE orders SET status='cancelled', cod_status='not_collected',
          cancel_reason=${input.reason}, cancelled_at=statement_timestamp(),
          returned_at=CASE WHEN ${returned} THEN statement_timestamp() ELSE NULL END,
          version=version+1, updated_at=statement_timestamp()
        WHERE id=${orderId}::uuid RETURNING version`);
      const version = updated!.version;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, reason, actor_kind,
          actor_id, command_id, order_version)
        VALUES (${orderId}::uuid, ${status}, 'cancelled', ${input.reason}, 'staff',
          ${context.actorId}::uuid, ${input.commandId}, ${version})`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO order_cancellations (order_id, command_id, actor_id, kind, from_status,
          request_hash, order_version, coupon_released)
        VALUES (${orderId}::uuid, ${input.commandId}::uuid, ${context.actorId}::uuid,
          ${returned ? "returned" : "before_handoff"}, ${status}, ${hash}, ${version},
          ${couponReleased})`);
      if (returned)
        for (const line of lines) {
          const item = input.returnItems!.find(
            (entry) => entry.variantId.toLowerCase() === line.variantId,
          )!;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO order_return_items (order_id, variant_id, sku, quantity,
              resellable_quantity, damaged_quantity)
            VALUES (${orderId}::uuid, ${line.variantId}::uuid, ${line.sku}, ${line.quantity},
              ${item.resellableQuantity}, ${item.damagedQuantity})`);
        }
      const units = (pick: (line: (typeof lines)[number]) => number) =>
        lines.reduce((sum, line) => sum + pick(line), 0);
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(
          { ...context, commandId: input.commandId },
          {
            action: "order.cancelled",
            entity: { type: "order", id: orderId },
            before: { status, version: order.version },
            // Counts and flags only; the reason is on the order and its history.
            after: {
              status: "cancelled",
              version,
              kind: returned ? "returned" : "before_handoff",
              restockedUnits: units((line) => back.get(line.variantId) ?? 0),
              damagedUnits: units((line) => line.quantity - (back.get(line.variantId) ?? 0)),
              couponReleased,
            },
          },
        ),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("order.cancelled", orderId, { orderId }, version),
      );
      const [row] = await tx.$queryRaw<Record_[]>(Prisma.sql`
        SELECT c.order_id AS "orderId", c.command_id::text AS "commandId",
          c.actor_id AS "actorId", u.name AS "actorName", c.kind, c.from_status AS "fromStatus",
          c.request_hash AS "requestHash", c.order_version AS "orderVersion",
          c.coupon_released AS "couponReleased", c.created_at AS "createdAt",
          ${input.reason} AS reason
        FROM order_cancellations c JOIN staff_users u ON u.id=c.actor_id
        WHERE c.order_id=${orderId}::uuid`);
      return receipt(tx, row!, false);
    });
  try {
    return await run();
  } catch (error) {
    if (dbCode(error) !== "23505") throw error;
    // Another attempt with this command ID committed first.
    const winner = await existing(db, input.commandId);
    if (!winner || !same(winner, context.actorId, orderId, hash))
      throw new OrderCancelConflictError("COMMAND_REUSED");
    return receipt(db, winner, true);
  }
}
