import {
  defineEvent,
  orderCollectionCorrectionRequestSchema,
  orderCollectionRequestSchema,
  orderCollectionResponseSchema,
  type ConflictCode,
  type OrderCollectionCorrectionRequest,
  type OrderCollectionRequest,
  type OrderCollectionResponse,
} from "@ih/contracts";
import type { PermissionKey } from "@ih/domain";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { canonicalPayloadHash } from "./idempotency";
import { lockOrder, OrderNotFoundError } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/**
 * Cash-on-delivery collection (roadmap step 87, ADR 0055). Delivery never records cash: this
 * command does, for a Delivered order whose cash is pending, with the amount, the time, the
 * actor and an optional reference. The order keeps that first record as its original evidence
 * for good. The Owner corrects it with a new record and a reason; nothing is overwritten.
 */
export class OrderCollectionForbiddenError extends Error {}
export class OrderCollectionNotFoundError extends Error {}
/** The collection time is in the future or before the order was delivered. */
export class OrderCollectionTimeError extends Error {}
export class OrderCollectionConflictError extends Error {
  constructor(
    readonly reason: Extract<
      ConflictCode,
      | "VERSION_CONFLICT"
      | "COMMAND_REUSED"
      | "COLLECTION_NOT_ALLOWED"
      | "NOT_COLLECTED"
      | "NO_CHANGES"
    >,
  ) {
    super(reason);
  }
}

interface Row {
  id: string;
  orderId: string;
  kind: "recorded" | "corrected";
  actorId: string;
  actorName: string;
  requestHash: Buffer;
  orderVersion: number;
  amountFils: bigint;
  collectedAt: Date;
  reference: string | null;
  reason: string | null;
  createdAt: Date;
}
const SELECT = Prisma.sql`
  SELECT r.id, r.order_id AS "orderId", r.kind, r.actor_id AS "actorId", u.name AS "actorName",
    r.request_hash AS "requestHash", r.order_version AS "orderVersion",
    r.amount_fils AS "amountFils", r.collected_at AS "collectedAt", r.reference, r.reason,
    r.created_at AS "createdAt"
  FROM order_collection_records r JOIN staff_users u ON u.id=r.actor_id`;
async function byCommand(tx: Database | Tx, commandId: string) {
  const [row] = await tx.$queryRaw<Row[]>(
    Prisma.sql`${SELECT} WHERE r.command_id=${commandId}::uuid`,
  );
  return row ?? null;
}
const receipt = (row: Row, replayed: boolean): OrderCollectionResponse =>
  orderCollectionResponseSchema.parse({
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    orderVersion: row.orderVersion,
    amountFils: Number(row.amountFils),
    collectedAt: row.collectedAt.toISOString(),
    reference: row.reference,
    reason: row.reason,
    actor: { id: row.actorId, name: row.actorName },
    recordedAt: row.createdAt.toISOString(),
    replayed,
  });
const same = (row: Row, kind: Row["kind"], actorId: string | null, orderId: string, hash: Buffer) =>
  row.kind === kind &&
  row.actorId === actorId &&
  row.orderId === orderId &&
  Buffer.from(row.requestHash).equals(hash);
function dbCode(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}

interface Command {
  kind: "recorded" | "corrected";
  permission: PermissionKey;
  orderId: string;
  expectedVersion: number;
  commandId: string;
  hash: Buffer;
  amountFils: number;
  reference: string | null;
  /** Null: the database's current time. */
  collectedAt: Date | null;
  reason: string | null;
}

async function run(db: Database, context: CommandContext, command: Command) {
  const attempt = () =>
    withTransaction(db, async (tx) => {
      try {
        await lockCatalogueActor(tx, context.actorId, [command.permission], true);
      } catch (error) {
        if (error instanceof CatalogueForbiddenError) throw new OrderCollectionForbiddenError();
        throw error;
      }
      const replay = async () => {
        const found = await byCommand(tx, command.commandId);
        if (!found) return null;
        if (!same(found, command.kind, context.actorId, command.orderId, command.hash))
          throw new OrderCollectionConflictError("COMMAND_REUSED");
        return receipt(found, true);
      };
      const early = await replay();
      if (early) return early;
      let order;
      try {
        order = await lockOrder(tx, command.orderId);
      } catch (error) {
        if (error instanceof OrderNotFoundError) throw new OrderCollectionNotFoundError();
        throw error;
      }
      const raced = await replay();
      if (raced) return raced;
      if (order.version !== command.expectedVersion)
        throw new OrderCollectionConflictError("VERSION_CONFLICT");
      const [state] = await tx.$queryRaw<
        Array<{ status: string; cod: string; deliveredAt: Date | null; now: Date; ok: boolean }>
      >(Prisma.sql`
        SELECT status, cod_status AS cod, delivered_at AS "deliveredAt",
          statement_timestamp() AS now,
          ${command.collectedAt}::timestamptz IS NULL OR (
            ${command.collectedAt}::timestamptz <= statement_timestamp()
            -- Staff enter the time to the minute: the minute of delivery counts.
            AND ${command.collectedAt}::timestamptz >= date_trunc('minute', delivered_at)) AS ok
        FROM orders WHERE id=${command.orderId}::uuid`);
      if (
        command.kind === "recorded" &&
        (state!.status !== "delivered" || state!.cod !== "pending")
      )
        throw new OrderCollectionConflictError("COLLECTION_NOT_ALLOWED");
      if (command.kind === "corrected" && state!.cod !== "collected")
        throw new OrderCollectionConflictError("NOT_COLLECTED");
      if (!state!.ok) throw new OrderCollectionTimeError();

      let before: { amountFils: number; collectedAt: string; reference: string | null } | null =
        null;
      if (command.kind === "corrected") {
        const [current] = await tx.$queryRaw<Array<Row & { sameTime: boolean }>>(Prisma.sql`
          SELECT r.amount_fils AS "amountFils", r.collected_at AS "collectedAt", r.reference,
            -- The API carries times to the millisecond; the stored record may hold microseconds.
            date_trunc('milliseconds', r.collected_at) = ${command.collectedAt}::timestamptz
              AS "sameTime"
          FROM order_collection_records r
          WHERE r.order_id=${command.orderId}::uuid ORDER BY r.seq DESC LIMIT 1`);
        before = {
          amountFils: Number(current!.amountFils),
          collectedAt: current!.collectedAt.toISOString(),
          reference: current!.reference,
        };
        if (
          before.amountFils === command.amountFils &&
          current!.sameTime &&
          before.reference === command.reference
        )
          throw new OrderCollectionConflictError("NO_CHANGES");
      }

      const [updated] = await tx.$queryRaw<Array<{ version: number }>>(
        command.kind === "recorded"
          ? Prisma.sql`
            UPDATE orders SET cod_status='collected', collected_amount_fils=${command.amountFils},
              collected_at=COALESCE(${command.collectedAt}::timestamptz, statement_timestamp()),
              collected_by=${context.actorId}::uuid, collection_reference=${command.reference},
              version=version+1, updated_at=statement_timestamp()
            WHERE id=${command.orderId}::uuid RETURNING version`
          : Prisma.sql`
            UPDATE orders SET version=version+1, updated_at=statement_timestamp()
            WHERE id=${command.orderId}::uuid RETURNING version`,
      );
      const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`
        WITH inserted AS (
          INSERT INTO order_collection_records (order_id, kind, command_id, actor_id, request_hash,
            order_version, amount_fils, collected_at, reference, reason)
          VALUES (${command.orderId}::uuid, ${command.kind}, ${command.commandId}::uuid,
            ${context.actorId}::uuid, ${command.hash}, ${updated!.version}, ${command.amountFils},
            -- The first record copies the order's evidence in SQL (no rounding through JS).
            ${
              command.kind === "recorded"
                ? Prisma.sql`(SELECT collected_at FROM orders WHERE id=${command.orderId}::uuid)`
                : Prisma.sql`${command.collectedAt}::timestamptz`
            },
            ${command.reference}, ${command.reason})
          RETURNING *)
        SELECT r.id, r.order_id AS "orderId", r.kind, r.actor_id AS "actorId", u.name AS "actorName",
          r.request_hash AS "requestHash", r.order_version AS "orderVersion",
          r.amount_fils AS "amountFils", r.collected_at AS "collectedAt", r.reference, r.reason,
          r.created_at AS "createdAt"
        FROM inserted r JOIN staff_users u ON u.id=r.actor_id`);
      const after = {
        amountFils: command.amountFils,
        collectedAt: row!.collectedAt.toISOString(),
        reference: command.reference,
      };
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(
          { ...context, commandId: command.commandId },
          {
            action:
              command.kind === "recorded"
                ? "order.collection_recorded"
                : "order.collection_corrected",
            entity: { type: "order", id: command.orderId },
            before: { version: order.version, collection: before },
            after: { version: updated!.version, collection: after },
            ...(command.reason ? { reason: command.reason } : {}),
          },
        ),
      );
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent(
          command.kind === "recorded" ? "order.collection_recorded" : "order.collection_corrected",
          command.orderId,
          { orderId: command.orderId },
          updated!.version,
        ),
      );
      return receipt(row!, false);
    });
  try {
    return await attempt();
  } catch (error) {
    if (dbCode(error) !== "23505") throw error;
    // Another attempt with this command ID, or a first record for this order, won the race.
    const winner = await byCommand(db, command.commandId);
    if (winner && same(winner, command.kind, context.actorId, command.orderId, command.hash))
      return receipt(winner, true);
    if (winner) throw new OrderCollectionConflictError("COMMAND_REUSED");
    throw new OrderCollectionConflictError(
      command.kind === "recorded" ? "COLLECTION_NOT_ALLOWED" : "VERSION_CONFLICT",
    );
  }
}

/** Records the cash of a Delivered order (`orders.collect`). */
export function recordCollection(
  db: Database,
  context: CommandContext,
  orderId: string,
  request: OrderCollectionRequest,
): Promise<OrderCollectionResponse> {
  const input = orderCollectionRequestSchema.parse(request);
  return run(db, context, {
    kind: "recorded",
    permission: "orders.collect",
    orderId,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    hash: canonicalPayloadHash({
      kind: "recorded",
      amountFils: input.amountFils,
      reference: input.reference ?? null,
      collectedAt: input.collectedAt ? new Date(input.collectedAt).toISOString() : null,
      expectedVersion: input.expectedVersion,
    }),
    amountFils: input.amountFils,
    reference: input.reference ?? null,
    collectedAt: input.collectedAt ? new Date(input.collectedAt) : null,
    reason: null,
  });
}

/** The Owner's correction of a recorded collection (`orders.collection_correct`). */
export function correctCollection(
  db: Database,
  context: CommandContext,
  orderId: string,
  request: OrderCollectionCorrectionRequest,
): Promise<OrderCollectionResponse> {
  const input = orderCollectionCorrectionRequestSchema.parse(request);
  const collectedAt = new Date(input.collectedAt);
  return run(db, context, {
    kind: "corrected",
    permission: "orders.collection_correct",
    orderId,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    hash: canonicalPayloadHash({
      kind: "corrected",
      amountFils: input.amountFils,
      reference: input.reference,
      collectedAt: collectedAt.toISOString(),
      reason: input.reason,
      expectedVersion: input.expectedVersion,
    }),
    amountFils: input.amountFils,
    reference: input.reference,
    collectedAt,
    reason: input.reason,
  });
}
