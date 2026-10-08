import { randomInt } from "node:crypto";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";

/**
 * Consumer-side effect persistence (architecture §8). Lock order everywhere: the effect row,
 * then its outbox_events row. Network work happens only between these short transactions.
 */

export interface ClaimedEffectRun {
  readonly effectId: string;
  readonly eventId: string;
  readonly consumer: string;
  readonly attempt: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

export class EffectLeaseLostError extends Error {
  readonly code = "EFFECT_LEASE_LOST";
}

/**
 * Claims one effect for execution. Returns null for duplicates and anything not runnable:
 * completed/skipped/dead effects, effects leased by a live runner, or retries not yet due.
 */
export async function claimEffect(
  db: Database,
  owner: string,
  effectId: string,
  consumer: string,
  leaseMs: number,
  maxAttempts: number,
): Promise<ClaimedEffectRun | null> {
  return withTransaction(db, async (tx) => {
    // A run whose lease expired with the budget used up (e.g. it crashed the process each time)
    // goes to dead instead of being reclaimed forever.
    await tx.$executeRaw(Prisma.sql`
      UPDATE consumer_effects
      SET status = 'dead', last_error = 'RETRY_EXHAUSTED:LEASE_EXPIRED',
          lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${effectId}::uuid AND consumer = ${consumer} AND status = 'running'
        AND lease_expires_at < now() AND attempts >= ${maxAttempts}`);
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        event_id: string;
        consumer: string;
        attempts: number;
        event_type: string;
        schema_version: number;
        aggregate_type: string;
        aggregate_id: string;
        payload: unknown;
      }>
    >(Prisma.sql`
      WITH claimed AS (
        UPDATE consumer_effects
        SET status = 'running', lease_owner = ${owner},
            lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
            heartbeat_at = now(), attempts = attempts + 1
        WHERE id = ${effectId}::uuid AND consumer = ${consumer} AND due_at <= now()
          AND attempts < ${maxAttempts}
          AND (status IN ('pending', 'queued', 'retry')
               OR (status = 'running' AND lease_expires_at < now()))
        RETURNING id, event_id, consumer, attempts
      )
      SELECT c.id, c.event_id, c.consumer, c.attempts, o.event_type, o.schema_version,
             o.aggregate_type, o.aggregate_id, o.payload
      FROM claimed c JOIN outbox_events o ON o.id = c.event_id`);
    const row = rows[0];
    if (!row) return null;
    return {
      effectId: row.id,
      eventId: row.event_id,
      consumer: row.consumer,
      attempt: row.attempts,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
    };
  });
}

/**
 * Runs `work` (the consumer's database effect) and marks the effect completed in ONE
 * transaction, then completes the parent event if every required effect is finished.
 * Throws EffectLeaseLostError (rolling everything back) if another runner owns the effect now.
 */
export async function completeEffect(
  db: Database,
  owner: string,
  effectId: string,
  work: (tx: Tx) => Promise<void>,
  receipt?: string,
  statementTimeoutMs = 15_000,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    // A hung database handler must not hold the effect/event locks past its lease.
    await tx.$queryRaw(
      Prisma.sql`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
    );
    const locked = await tx.$queryRaw<Array<{ event_id: string }>>(Prisma.sql`
      SELECT event_id FROM consumer_effects
      WHERE id = ${effectId}::uuid AND status = 'running' AND lease_owner = ${owner}
      FOR UPDATE`);
    const eventId = locked[0]?.event_id;
    if (!eventId) throw new EffectLeaseLostError("Effect lease lost before completion");
    await work(tx);
    await tx.$executeRaw(Prisma.sql`
      UPDATE consumer_effects
      SET status = 'completed', completed_at = now(), lease_owner = NULL,
          lease_expires_at = NULL, last_error = NULL,
          external_receipt = COALESCE(${receipt ?? null}, external_receipt)
      WHERE id = ${effectId}::uuid`);
    // Lock the event, then check siblings in a NEW statement: under Read Committed it sees
    // effects committed by concurrent runners while we waited, so the last finisher completes it.
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM outbox_events WHERE id = ${eventId}::uuid FOR UPDATE`,
    );
    await tx.$executeRaw(Prisma.sql`
      -- The relay lease is left alone: a fast consumer may finish before the relay marks dispatch.
      UPDATE outbox_events SET completed_at = now()
      WHERE id = ${eventId}::uuid AND completed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM consumer_effects e
          WHERE e.event_id = ${eventId}::uuid AND e.status NOT IN ('completed', 'skipped'))`);
  });
}

export interface FailureDecision {
  readonly status: "retry" | "dead";
  readonly dueAt?: Date;
  readonly delayMs?: number;
}

/** Exponential backoff with ±50 % jitter, capped at 15 minutes. */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(15 * 60_000, 2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 20));
  return Math.round(base / 2 + randomInt(0, Math.max(1, Math.round(base))) / 2);
}

/**
 * Records a failed attempt with a safe error code. Permanent errors or an exhausted attempt
 * budget make the effect dead (investigable, replayable in step 24); otherwise it becomes retry.
 * Returns null if the lease was lost (another runner owns the effect).
 */
export async function recordEffectFailure(
  db: Database,
  owner: string,
  effectId: string,
  errorCode: string,
  options: { permanent: boolean; attempt: number; maxAttempts: number; receipt?: string },
): Promise<FailureDecision | null> {
  const dead = options.permanent || options.attempt >= options.maxAttempts;
  const code = (dead && !options.permanent ? "RETRY_EXHAUSTED:" : "") + errorCode;
  const delayMs = dead ? 0 : retryDelayMs(options.attempt);
  // due_at uses the database clock, the same clock the claim compares against.
  const rows = await db.$queryRaw<Array<{ due_at: Date }>>(Prisma.sql`
    UPDATE consumer_effects
    SET status = ${dead ? "dead" : "retry"}, last_error = ${code.slice(0, 120)},
        lease_owner = NULL, lease_expires_at = NULL,
        external_receipt = COALESCE(${options.receipt ?? null}, external_receipt),
        due_at = CASE WHEN ${dead} THEN due_at
                      ELSE now() + make_interval(secs => ${delayMs / 1000}) END
    WHERE id = ${effectId}::uuid AND status = 'running' AND lease_owner = ${owner}
    RETURNING due_at`);
  if (rows.length !== 1) return null;
  return dead ? { status: "dead" } : { status: "retry", dueAt: rows[0]!.due_at, delayMs };
}

/** Renews the lease of a running effect. False means the lease was lost: stop working. */
export async function heartbeatEffect(
  db: Database,
  owner: string,
  effectId: string,
  leaseMs: number,
): Promise<boolean> {
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE consumer_effects
    SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = ${effectId}::uuid AND status = 'running' AND lease_owner = ${owner}`);
  return updated === 1;
}
