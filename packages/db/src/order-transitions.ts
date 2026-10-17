import {
  defineEvent,
  orderBulkConfirmRequestSchema,
  orderBulkConfirmResponseSchema,
  type OrderBulkConfirmRequest,
  type OrderBulkConfirmResponse,
  orderTransitionRequestSchema,
  orderTransitionResponseSchema,
  type ConflictCode,
  type OrderTransitionRequest,
  type OrderTransitionResponse,
} from "@ih/contracts";
import { canTransition, type OrderStatus } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { lockCatalogueActor, CatalogueForbiddenError } from "./catalogue-parents";
import { lockOrder, OrderNotFoundError } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { TransactionContentionError, withTransaction } from "./transaction";

export class OrderTransitionForbiddenError extends CatalogueForbiddenError {}
export class OrderTransitionNotFoundError extends Error {}
export class OrderTransitionConflictError extends Error {
  constructor(
    readonly reason: Extract<
      ConflictCode,
      "VERSION_CONFLICT" | "INVALID_TRANSITION" | "COMMAND_REUSED"
    >,
  ) {
    super(reason);
  }
}

interface HistoryRow {
  orderId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  orderVersion: number;
  actorId: string;
  actorName: string;
  createdAt: Date;
}

async function existingCommand(tx: Database | Tx, commandId: string): Promise<HistoryRow | null> {
  const [row] = await tx.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT h.order_id AS "orderId", h.from_status AS "fromStatus", h.to_status AS "toStatus",
      h.order_version AS "orderVersion", h.actor_id AS "actorId", u.name AS "actorName",
      h.created_at AS "createdAt"
    FROM order_status_history h JOIN staff_users u ON u.id=h.actor_id
    WHERE h.command_id=${commandId}`);
  return row ?? null;
}

function receipt(row: HistoryRow, replayed: boolean): OrderTransitionResponse {
  return orderTransitionResponseSchema.parse({
    orderId: row.orderId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    orderVersion: row.orderVersion,
    transitionedAt: row.createdAt.toISOString(),
    actor: { id: row.actorId, name: row.actorName },
    replayed,
  });
}

function sameCommand(
  row: HistoryRow,
  context: CommandContext,
  orderId: string,
  input: OrderTransitionRequest,
) {
  return (
    row.orderId === orderId &&
    row.actorId === context.actorId &&
    row.toStatus === input.to &&
    row.orderVersion === input.expectedVersion + 1
  );
}

function databaseCode(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}

/** Normal fulfilment state change. Cancellation and COD collection have separate commands. */
export async function transitionOrder(
  db: Database,
  context: CommandContext,
  orderId: string,
  request: OrderTransitionRequest,
): Promise<OrderTransitionResponse> {
  const input = orderTransitionRequestSchema.parse(request);
  const run = () =>
    withTransaction(db, async (tx) => {
      try {
        await lockCatalogueActor(tx, context.actorId, ["orders.transition"], true);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new OrderTransitionForbiddenError();
        throw error;
      }
      const early = await existingCommand(tx, input.commandId);
      if (early) {
        if (!sameCommand(early, context, orderId, input))
          throw new OrderTransitionConflictError("COMMAND_REUSED");
        return receipt(early, true);
      }
      let order;
      try {
        order = await lockOrder(tx, orderId);
      } catch (error) {
        if (error instanceof OrderNotFoundError) throw new OrderTransitionNotFoundError();
        throw error;
      }
      const raced = await existingCommand(tx, input.commandId);
      if (raced) {
        if (!sameCommand(raced, context, orderId, input))
          throw new OrderTransitionConflictError("COMMAND_REUSED");
        return receipt(raced, true);
      }
      if (order.version !== input.expectedVersion)
        throw new OrderTransitionConflictError("VERSION_CONFLICT");
      if (!canTransition(order.status as OrderStatus, input.to))
        throw new OrderTransitionConflictError("INVALID_TRANSITION");
      const [updated] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
      UPDATE orders SET status=${input.to}, version=version+1, updated_at=statement_timestamp(),
        dispatched_at=CASE WHEN ${input.to}='out_for_delivery' THEN statement_timestamp() ELSE dispatched_at END,
        delivered_at=CASE WHEN ${input.to}='delivered' THEN statement_timestamp() ELSE delivered_at END
      WHERE id=${order.id}::uuid RETURNING version`);
      const [history] = await tx.$queryRaw<HistoryRow[]>(Prisma.sql`
      WITH inserted AS (INSERT INTO order_status_history
        (order_id,from_status,to_status,actor_kind,actor_id,command_id,order_version)
      VALUES (${order.id}::uuid,${order.status},${input.to},'staff',${context.actorId}::uuid,
        ${input.commandId},${updated!.version})
      RETURNING order_id,from_status,to_status,order_version,actor_id,created_at)
      SELECT i.order_id AS "orderId", i.from_status AS "fromStatus", i.to_status AS "toStatus",
        i.order_version AS "orderVersion", i.actor_id AS "actorId", u.name AS "actorName",
        i.created_at AS "createdAt" FROM inserted i JOIN staff_users u ON u.id=i.actor_id`);
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(
          { ...context, commandId: input.commandId },
          {
            action: "order.status_changed",
            entity: { type: "order", id: order.id },
            before: { status: order.status, version: order.version },
            after: { status: input.to, version: updated!.version },
          },
        ),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent(
          "order.status_changed",
          order.id,
          {
            orderId: order.id,
            from: order.status as OrderStatus,
            to: input.to,
          },
          updated!.version,
        ),
      );
      return receipt(history!, false);
    });
  try {
    return await run();
  } catch (error) {
    if (databaseCode(error) !== "23505") throw error;
    const winner = await existingCommand(db, input.commandId);
    if (!winner || !sameCommand(winner, context, orderId, input))
      throw new OrderTransitionConflictError("COMMAND_REUSED");
    return receipt(winner, true);
  }
}

/**
 * Bulk confirm (roadmap step 89, ADR 0057). Each order is its own `transitionOrder` to
 * Confirmed, in its own transaction, with the version and command ID the operator's screen
 * sent; one order's refusal never undoes or blocks another. Orders are taken in the order
 * given, one at a time. Retrying the same batch replays every command that already applied.
 */
export async function bulkConfirmOrders(
  db: Database,
  context: CommandContext,
  request: OrderBulkConfirmRequest,
): Promise<OrderBulkConfirmResponse> {
  const input = orderBulkConfirmRequestSchema.parse(request);
  const results: OrderBulkConfirmResponse["results"] = [];
  for (const item of input.orders) {
    const refused = (code: string) =>
      results.push({
        orderId: item.orderId,
        outcome: "refused",
        code,
        orderVersion: null,
        replayed: false,
      });
    try {
      const receipt = await transitionOrder(
        db,
        { ...context, commandId: item.commandId },
        item.orderId,
        { to: "confirmed", expectedVersion: item.expectedVersion, commandId: item.commandId },
      );
      results.push({
        orderId: item.orderId,
        outcome: "confirmed",
        code: null,
        orderVersion: receipt.orderVersion,
        replayed: receipt.replayed,
      });
    } catch (error) {
      if (error instanceof OrderTransitionConflictError) refused(error.reason);
      else if (error instanceof OrderTransitionNotFoundError) refused("NOT_FOUND");
      else if (error instanceof OrderTransitionForbiddenError) refused("FORBIDDEN");
      else if (error instanceof TransactionContentionError) refused(error.code);
      else throw error;
    }
  }
  return orderBulkConfirmResponseSchema.parse({ results });
}
