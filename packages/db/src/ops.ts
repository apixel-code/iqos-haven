import {
  CLOSED_ALERT,
  nextAlertState,
  type AlertEvaluation,
  type AlertNotice,
  type AlertState,
} from "@ih/domain";
import { Prisma, type Database } from "./client";
import { ledgerMismatchCount } from "./launch-readiness";
import { withTransaction } from "./transaction";

/** Database-side operational signals (roadmap step 125, architecture §15). Counts only. */
export interface OpsSignals {
  /** Age of the oldest effect not yet completed, dead or skipped; 0 when there is none. */
  oldestOpenEffectSeconds: number;
  deadEffects: number;
  /** Age of the oldest open storefront cache invalidation. */
  oldestOpenRevalidateSeconds: number;
  ledgerMismatches: number;
  connections: { used: number; max: number };
}

const OPEN = Prisma.sql`status IN ('pending', 'queued', 'running', 'retry')`;

export async function opsSignals(db: Database): Promise<OpsSignals> {
  const [effects] = await db.$queryRaw<
    Array<{ oldest: number; dead: number; revalidate: number }>
  >(Prisma.sql`SELECT
      coalesce(extract(epoch FROM statement_timestamp() - min(created_at) FILTER (WHERE ${OPEN})), 0)::int AS oldest,
      count(*) FILTER (WHERE status = 'dead')::int AS dead,
      coalesce(extract(epoch FROM statement_timestamp() - min(created_at)
        FILTER (WHERE ${OPEN} AND consumer = 'storefront_revalidate')), 0)::int AS revalidate
    FROM consumer_effects`);
  const [connections] = await db.$queryRaw<Array<{ used: number; max: number }>>(Prisma.sql`
    SELECT (SELECT count(*) FROM pg_stat_activity)::int AS used,
      current_setting('max_connections')::int AS max`);
  return {
    oldestOpenEffectSeconds: effects?.oldest ?? 0,
    deadEffects: effects?.dead ?? 0,
    oldestOpenRevalidateSeconds: effects?.revalidate ?? 0,
    ledgerMismatches: await ledgerMismatchCount(db),
    connections: { used: connections?.used ?? 0, max: connections?.max ?? 0 },
  };
}

interface AlertRow {
  key: string;
  firing: boolean;
  consecutive: number;
  summary: string | null;
  openedAt: Date | null;
  lastNotifiedAt: Date | null;
  resolvedAt: Date | null;
}

/**
 * Applies one monitor run's evaluations to the stored alert state and returns the notices to
 * send. Rows are locked in key order, so two monitor runs never both open the same alert.
 */
export async function applyAlertEvaluations(
  db: Database,
  evaluations: readonly AlertEvaluation[],
  now: Date,
  remindAfterMs: number,
): Promise<AlertNotice[]> {
  const sorted = [...evaluations].sort((a, b) => a.key.localeCompare(b.key));
  if (!sorted.length) return [];
  return withTransaction(db, async (tx) => {
    const keys = sorted.map((evaluation) => evaluation.key);
    await tx.$executeRaw(Prisma.sql`INSERT INTO ops_alerts (key)
      SELECT unnest(${keys}::varchar[]) ON CONFLICT (key) DO NOTHING`);
    const rows = await tx.$queryRaw<AlertRow[]>(Prisma.sql`SELECT key, firing, consecutive,
        summary, opened_at AS "openedAt", last_notified_at AS "lastNotifiedAt",
        resolved_at AS "resolvedAt"
      FROM ops_alerts WHERE key = ANY(${keys}::varchar[]) ORDER BY key FOR UPDATE`);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const notices: AlertNotice[] = [];
    for (const evaluation of sorted) {
      const row = byKey.get(evaluation.key);
      const previous: AlertState = row ? { ...row } : CLOSED_ALERT;
      const { state, notice } = nextAlertState(previous, evaluation, now, remindAfterMs);
      await tx.$executeRaw(Prisma.sql`UPDATE ops_alerts SET firing = ${state.firing},
          consecutive = ${state.consecutive}, summary = ${state.summary?.slice(0, 300) ?? null},
          opened_at = ${state.openedAt}, last_notified_at = ${state.lastNotifiedAt},
          resolved_at = ${state.resolvedAt}, updated_at = statement_timestamp()
        WHERE key = ${evaluation.key}`);
      if (notice) notices.push(notice);
    }
    return notices;
  });
}

/** Open alerts, for the test-alert command and diagnostics. */
export function openAlerts(db: Database) {
  return db.$queryRaw<Array<{ key: string; summary: string | null; openedAt: Date }>>(Prisma.sql`
    SELECT key, summary, opened_at AS "openedAt" FROM ops_alerts WHERE firing ORDER BY key`);
}
