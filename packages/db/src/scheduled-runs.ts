import { Prisma, type Database } from "./client";
import { withTransaction } from "./transaction";

/** Durable schedule slots: unique per (job, slot) across replicas (architecture §8 Scheduling). */

export interface ClaimedRun {
  readonly id: string;
  readonly jobName: string;
  readonly slot: Date;
  readonly attempt: number;
}

/** Creates the slots if missing. Existing slots (any status) are left untouched. */
export async function ensureSlots(
  db: Database,
  jobName: string,
  slots: readonly Date[],
): Promise<void> {
  if (!slots.length) return;
  await db.$executeRaw(Prisma.sql`
    INSERT INTO scheduled_runs (job_name, slot)
    SELECT ${jobName}, s FROM unnest(${slots.map((slot) => slot.toISOString())}::timestamptz[]) AS s
    ON CONFLICT (job_name, slot) DO NOTHING`);
}

/**
 * Leases the oldest runnable slot of one job (pending, or running with an expired lease).
 * One slot per call: each run's lease starts when it is about to execute. A slot whose lease
 * expired with its budget used (it crashed the process each time) becomes failed instead.
 */
export async function claimNextRun(
  db: Database,
  owner: string,
  jobName: string,
  leaseMs: number,
  maxAttempts: number,
): Promise<ClaimedRun | null> {
  return withTransaction(db, async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      UPDATE scheduled_runs
      SET status = 'failed', last_error = 'RETRY_EXHAUSTED:LEASE_EXPIRED',
          lease_owner = NULL, lease_expires_at = NULL
      WHERE job_name = ${jobName} AND status = 'running' AND lease_expires_at < now()
        AND attempts >= ${maxAttempts}`);
    const rows = await tx.$queryRaw<
      Array<{ id: string; job_name: string; slot: Date; attempts: number }>
    >(Prisma.sql`
      WITH due AS (
        SELECT id FROM scheduled_runs
        WHERE job_name = ${jobName} AND slot <= now() AND attempts < ${maxAttempts}
          AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
        ORDER BY slot, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE scheduled_runs r
      SET status = 'running', lease_owner = ${owner}, attempts = r.attempts + 1,
          lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
      FROM due WHERE r.id = due.id
      RETURNING r.id, r.job_name, r.slot, r.attempts`);
    const row = rows[0];
    return row
      ? { id: row.id, jobName: row.job_name, slot: row.slot, attempt: row.attempts }
      : null;
  });
}

export async function completeRun(db: Database, owner: string, runId: string): Promise<boolean> {
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE scheduled_runs
    SET status = 'completed', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
        last_error = NULL
    WHERE id = ${runId}::uuid AND status = 'running' AND lease_owner = ${owner}`);
  return updated === 1;
}

/** Back to pending for the next tick, or failed (investigable) once the budget is used. */
export async function failRun(
  db: Database,
  owner: string,
  runId: string,
  errorCode: string,
  options: { attempt: number; maxAttempts: number },
): Promise<"pending" | "failed" | null> {
  const failed = options.attempt >= options.maxAttempts;
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE scheduled_runs
    SET status = ${failed ? "failed" : "pending"}, last_error = ${errorCode.slice(0, 120)},
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ${runId}::uuid AND status = 'running' AND lease_owner = ${owner}`);
  return updated === 1 ? (failed ? "failed" : "pending") : null;
}
