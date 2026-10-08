import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";

/**
 * Relay persistence (architecture §8). Each function is one short transaction; the caller
 * enqueues to Redis between them, never while a transaction is open.
 * Lock order everywhere: consumer_effects rows before their outbox_events row.
 */

export interface ClaimedEffect {
  readonly id: string;
  readonly eventId: string;
  readonly consumer: string;
  readonly dueAt: Date;
}

export interface ClaimedEvent {
  readonly id: string;
  readonly eventType: string;
  readonly dispatchAttempts: number;
  readonly effects: readonly ClaimedEffect[];
}

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Leases up to `limit` undispatched, incomplete events whose lease is free or expired.
 * SKIP LOCKED lets concurrent relays claim disjoint batches without waiting.
 */
export async function claimDueEvents(
  db: Database,
  owner: string,
  limit: number,
  leaseMs: number,
): Promise<ClaimedEvent[]> {
  return withTransaction(db, async (tx) => {
    const events = await tx.$queryRaw<
      Array<{ id: string; event_type: string; dispatch_attempts: number }>
    >(Prisma.sql`
      WITH due AS (
        SELECT id FROM outbox_events
        WHERE completed_at IS NULL AND dispatched_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET lease_owner = ${owner},
          lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
          dispatch_attempts = o.dispatch_attempts + 1
      FROM due WHERE o.id = due.id
      RETURNING o.id, o.event_type, o.dispatch_attempts`);
    if (!events.length) return [];
    const ids = events.map((event) => event.id);
    const effects = await tx.$queryRaw<
      Array<{ id: string; event_id: string; consumer: string; due_at: Date }>
    >(Prisma.sql`
      SELECT id, event_id, consumer, due_at FROM consumer_effects
      WHERE event_id = ANY(${ids}::uuid[]) AND status = 'pending'
      ORDER BY event_id, consumer`);
    return events
      .map((event) => ({
        id: event.id,
        eventType: event.event_type,
        dispatchAttempts: event.dispatch_attempts,
        effects: effects
          .filter((effect) => effect.event_id === event.id)
          .map((effect) => ({
            id: effect.id,
            eventId: effect.event_id,
            consumer: effect.consumer,
            dueAt: effect.due_at,
          })),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });
}

/**
 * After every job was enqueued: pending effects become queued and the event is marked
 * dispatched, but only while this relay still holds the lease. Returns false if the lease was
 * lost (another relay reclaimed it); duplicate jobs are then deduplicated by job ID / effect row.
 */
export async function markDispatched(
  db: Database,
  owner: string,
  eventId: string,
  effectIds: readonly string[],
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    // Effects are updated before the lease check to keep the effects→event lock order. A stale
    // relay can therefore flip pending→queued, which is harmless: its job was already enqueued.
    if (effectIds.length)
      await tx.$executeRaw(Prisma.sql`
        UPDATE consumer_effects SET status = 'queued', queued_at = now()
        WHERE event_id = ${eventId}::uuid AND id = ANY(${[...effectIds]}::uuid[]) AND status = 'pending'`);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE outbox_events
      SET dispatched_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = ${eventId}::uuid AND lease_owner = ${owner} AND dispatched_at IS NULL`);
    return updated === 1;
  });
}

/**
 * Enqueue failed: keep the lease (it now acts as exponential backoff) and record a safe error
 * code. Never store provider/Redis messages; they may echo payload data.
 */
export async function recordDispatchFailure(
  db: Database,
  owner: string,
  eventId: string,
  errorCode: string,
  attempts: number,
): Promise<void> {
  const backoffMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 20));
  await db.$executeRaw(Prisma.sql`
    UPDATE outbox_events
    SET last_error = ${errorCode.slice(0, 64)},
        lease_expires_at = now() + make_interval(secs => ${backoffMs / 1000})
    WHERE id = ${eventId}::uuid AND lease_owner = ${owner}`);
}
