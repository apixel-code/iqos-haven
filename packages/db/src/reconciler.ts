import { toAuditEntry, type CommandContext } from "@ih/application";
import { PrismaAuditWriter } from "./audit";
import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";

/**
 * Recovery after Redis job loss or crashed runners (architecture §8). The database is the
 * source of truth: anything unfinished and not actively leased is found here and re-enqueued.
 */

export interface StrandedEffect {
  readonly effectId: string;
  readonly eventId: string;
  readonly consumer: string;
  readonly status: "pending" | "queued" | "retry" | "running";
}

/**
 * Unfinished effects without live work: replayed `pending` effects of dispatched events (at once),
 * `queued` effects older than `staleMs`, `retry` effects overdue by `staleMs`, and `running`
 * effects whose lease expired. Effects with a live lease are never returned.
 */
export async function findStrandedEffects(
  db: Database,
  staleMs: number,
  limit: number,
): Promise<StrandedEffect[]> {
  const stale = Prisma.sql`now() - make_interval(secs => ${staleMs / 1000})`;
  const columns = Prisma.sql`e.id, e.event_id, e.consumer, e.status, e.due_at`;
  // One branch per status so each can use its partial index (due/queued/running indexes).
  const rows = await db.$queryRaw<
    Array<{ id: string; event_id: string; consumer: string; status: StrandedEffect["status"] }>
  >(Prisma.sql`
    SELECT id, event_id, consumer, status FROM (
    (SELECT ${columns} FROM consumer_effects e JOIN outbox_events o ON o.id = e.event_id
      -- pending + dispatched only arises from a replay: enqueue it without waiting.
      WHERE e.status = 'pending' AND o.dispatched_at IS NOT NULL
      ORDER BY e.due_at, e.id LIMIT ${limit})
    UNION ALL
    (SELECT ${columns} FROM consumer_effects e
      WHERE e.status = 'queued' AND e.queued_at < ${stale}
      ORDER BY e.queued_at, e.id LIMIT ${limit})
    UNION ALL
    (SELECT ${columns} FROM consumer_effects e
      WHERE e.status = 'retry' AND e.due_at < ${stale}
      ORDER BY e.due_at, e.id LIMIT ${limit})
    UNION ALL
    (SELECT ${columns} FROM consumer_effects e
      WHERE e.status = 'running' AND e.lease_expires_at < now()
      ORDER BY e.lease_expires_at, e.id LIMIT ${limit})
    ) stranded
    -- Merge branches oldest-due first so a burst of one status cannot starve the others.
    ORDER BY due_at, id
    LIMIT ${limit}`);
  return rows.map((row) => ({
    effectId: row.id,
    eventId: row.event_id,
    consumer: row.consumer,
    status: row.status,
  }));
}

/** After re-enqueueing: pending → queued and refresh queued_at so the stale clock restarts. */
export async function markRequeued(db: Database, effectIds: readonly string[]): Promise<number> {
  if (!effectIds.length) return 0;
  return db.$executeRaw(Prisma.sql`
    UPDATE consumer_effects SET status = 'queued', queued_at = now()
    WHERE id = ANY(${[...effectIds]}::uuid[]) AND status IN ('pending', 'queued')`);
}

/**
 * Completes dispatched events whose required effects are all completed/skipped but whose
 * completion was not recorded (the normal path completes them in the effect transaction).
 */
export async function completeFinishedEvents(db: Database, limit: number): Promise<number> {
  return withTransaction(db, (tx) =>
    tx.$executeRaw(Prisma.sql`
      UPDATE outbox_events SET completed_at = now()
      WHERE id IN (
        SELECT o.id FROM outbox_events o
        WHERE o.completed_at IS NULL AND o.dispatched_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM consumer_effects e
            WHERE e.event_id = o.id AND e.status NOT IN ('completed', 'skipped'))
        ORDER BY o.created_at, o.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)`),
  );
}

/** Dead-effect inspection: identifiers and safe codes only, never payloads. */
export interface DeadEffect {
  readonly effectId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly consumer: string;
  readonly attempts: number;
  readonly replays: number;
  readonly lastError: string;
  readonly diedAt: Date;
}

export async function listDeadEffects(
  db: Database,
  options: { limit: number; consumer?: string },
): Promise<DeadEffect[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      event_id: string;
      event_type: string;
      consumer: string;
      attempts: number;
      replays: number;
      last_error: string;
      updated_at: Date;
    }>
  >(Prisma.sql`
    SELECT e.id, e.event_id, o.event_type, e.consumer, e.attempts, e.replays, e.last_error,
           e.updated_at
    FROM consumer_effects e JOIN outbox_events o ON o.id = e.event_id
    WHERE e.status = 'dead' ${options.consumer ? Prisma.sql`AND e.consumer = ${options.consumer}` : Prisma.empty}
    ORDER BY e.updated_at, e.id
    LIMIT ${Math.min(Math.max(options.limit, 1), 200)}`);
  return rows.map((row) => ({
    effectId: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    consumer: row.consumer,
    attempts: row.attempts,
    replays: row.replays,
    lastError: row.last_error,
    diedAt: row.updated_at,
  }));
}

export class EffectNotDeadError extends Error {
  readonly code = "EFFECT_NOT_DEAD";
}

/**
 * Replays one dead effect after its cause was repaired: dead → pending with a fresh attempt
 * budget (the trigger counts `replays`), audited in the same transaction. The reconciler
 * enqueues it. Permission checks belong to the caller (admin API arrives with RBAC, step 27+).
 */
export async function replayDeadEffect(
  db: Database,
  context: CommandContext,
  effectId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim() || reason.length > 500) throw new RangeError("Replay needs a reason (1–500)");
  const audit = new PrismaAuditWriter();
  await withTransaction(db, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ consumer: string; attempts: number; replays: number; last_error: string }>
    >(Prisma.sql`
      SELECT consumer, attempts, replays, last_error FROM consumer_effects
      WHERE id = ${effectId}::uuid AND status = 'dead' FOR UPDATE`);
    const before = rows[0];
    if (!before) throw new EffectNotDeadError("Effect is not dead");
    await tx.$executeRaw(Prisma.sql`
      UPDATE consumer_effects
      SET status = 'pending', attempts = 0, due_at = now(), queued_at = NULL
      WHERE id = ${effectId}::uuid`);
    await audit.append(
      tx,
      toAuditEntry(context, {
        action: "effect.replayed",
        entity: { type: "consumer_effect", id: effectId },
        before: { status: "dead", attempts: before.attempts, lastError: before.last_error },
        after: { status: "pending", attempts: 0, replays: before.replays + 1 },
        reason,
      }),
    );
  });
}
