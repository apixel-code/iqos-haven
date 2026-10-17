import { toAuditEntry, type CommandContext } from "@ih/application";
import {
  CSV_BOM,
  csvLine,
  PERSONAL_DATA_REPORTS,
  REPORT_BUILD_STALE_HOURS,
  REPORT_FILE_MAX_ROWS,
  REPORT_FILE_RETENTION_DAYS,
  type PermissionKey,
} from "@ih/domain";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { Prisma, type Database } from "./client";
import { reportFileName, reportRows } from "./report-csv";
import {
  parseStoredReport,
  ReportForbiddenError,
  ReportNotAvailableError,
  ReportNotFoundError,
} from "./report-jobs";
import { withTransaction } from "./transaction";

/**
 * Built report files (roadmap step 112, ADR 0078). The worker claims a queued file job, builds
 * its CSV from one repeatable-read snapshot (no network inside), uploads it to the private
 * reports bucket outside any transaction, then records it. The key is fixed per job, so a
 * repeated build overwrites the same object and completes once.
 */
export const reportArtifactKey = (jobId: string) => `reports/${jobId}.csv`;

export type ReportBuild =
  | { outcome: "skip"; status: string }
  | { outcome: "fail"; code: string }
  | { outcome: "built"; key: string; text: string; rowCount: number; fileName: string };

/** Claims and builds a file job. Never uploads: the caller stores `text` and then completes. */
export async function buildReportFile(db: Database, jobId: string): Promise<ReportBuild> {
  const [claimed] = await db.$queryRaw<
    Array<{ type: string; params: unknown; requestedBy: string; required: string[] }>
  >(Prisma.sql`
    UPDATE report_jobs SET status='running', attempts=attempts+1,
      started_at=coalesce(started_at, statement_timestamp())
    WHERE id=${jobId}::uuid AND delivery='file' AND status IN ('queued','running')
    RETURNING type, params, requested_by AS "requestedBy", required_permissions AS required`);
  if (!claimed) {
    const [row] = await db.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM report_jobs WHERE id=${jobId}::uuid`,
    );
    return { outcome: "skip", status: row?.status ?? "missing" };
  }
  return db.$transaction(
    async (tx) => {
      // Built for the requester only while they still may have it.
      try {
        await lockCatalogueActor(
          tx,
          claimed.requestedBy,
          claimed.required as PermissionKey[],
          false,
        );
      } catch (error) {
        if (error instanceof CatalogueForbiddenError)
          return { outcome: "fail", code: "REQUESTER_FORBIDDEN" } as const;
        throw error;
      }
      const [{ now }] = (await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT now() AS now`,
      )) as [{ now: Date }];
      const report = parseStoredReport(claimed.type, claimed.params);
      const parts: string[] = [CSV_BOM];
      let rowCount = -1;
      for await (const row of reportRows(tx, report, now)) {
        if (rowCount >= REPORT_FILE_MAX_ROWS)
          return { outcome: "fail", code: "REPORT_TOO_LARGE" } as const;
        parts.push(csvLine(row));
        rowCount++;
      }
      return {
        outcome: "built",
        key: reportArtifactKey(jobId),
        text: parts.join(""),
        rowCount,
        fileName: reportFileName(report, now),
      } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 },
  );
}

/** Records the stored file; kept `REPORT_FILE_RETENTION_DAYS`. False if no longer running. */
export async function completeReportFile(
  db: Database,
  jobId: string,
  file: { key: string; rowCount: number; byteSize: number },
): Promise<boolean> {
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE report_jobs SET status='completed', artifact_key=${file.key}, row_count=${file.rowCount},
      byte_size=${file.byteSize}, completed_at=statement_timestamp(),
      expires_at=statement_timestamp() + make_interval(days => ${REPORT_FILE_RETENTION_DAYS}::int)
    WHERE id=${jobId}::uuid AND status='running'`);
  return updated === 1;
}

/** The job's status now (`missing` if there is none). */
export async function reportJobStatus(db: Database, jobId: string): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`SELECT status FROM report_jobs WHERE id=${jobId}::uuid`,
  );
  return row?.status ?? "missing";
}

export async function failReportFile(db: Database, jobId: string, code: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE report_jobs SET status='failed', error_code=${code.slice(0, 64)}
    WHERE id=${jobId}::uuid AND status IN ('queued','running')`);
}

/**
 * Authorizes one download of a built file (step 112): the requester's own job, every required
 * right still held, completed and not expired. The download is audited before the caller signs
 * a short link, so no link exists without its audit entry.
 */
export async function issueReportFileDownload(
  db: Database,
  context: CommandContext,
  jobId: string,
): Promise<{ key: string; fileName: string }> {
  if (!context.actorId) throw new ReportForbiddenError();
  const actorId = context.actorId;
  return withTransaction(db, async (tx) => {
    const [job] = await tx.$queryRaw<
      Array<{
        id: string;
        type: string;
        params: unknown;
        delivery: string;
        status: string;
        live: boolean;
        key: string | null;
        rowCount: number | null;
        required: string[];
        completedAt: Date | null;
      }>
    >(Prisma.sql`SELECT id, type, params, delivery, status, artifact_key AS key,
        row_count AS "rowCount", required_permissions AS required, completed_at AS "completedAt",
        coalesce(expires_at > now(), false) AS live
      FROM report_jobs WHERE id=${jobId}::uuid AND requested_by=${actorId}::uuid`);
    if (!job) throw new ReportNotFoundError();
    try {
      await lockCatalogueActor(tx, actorId, job.required as PermissionKey[], false);
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ReportForbiddenError();
      throw error;
    }
    if (job.delivery !== "file" || job.status !== "completed" || !job.live || !job.key)
      throw new ReportNotAvailableError();
    const report = parseStoredReport(job.type, job.params);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "report.downloaded",
        entity: { type: "report_job", id: job.id },
        after: {
          type: report.type,
          rows: job.rowCount,
          personalData: PERSONAL_DATA_REPORTS.includes(report.type),
        },
      }),
    );
    return { key: job.key, fileName: reportFileName(report, job.completedAt!) };
  });
}

/**
 * Upkeep (step 112): expire live streams past their time; fail file jobs that never finished
 * (their effect died, or older than the stale limit). Returns the completed files past their
 * retention, for the caller to delete from storage and then mark with `markReportFileExpired`.
 */
export async function reportMaintenance(db: Database): Promise<{
  streamsExpired: number;
  /** File jobs failed now: any object a slow build may still have stored is to be deleted. */
  staleIds: string[];
  filesToDelete: Array<{ id: string; key: string }>;
}> {
  const streamsExpired = await db.$executeRaw(Prisma.sql`
    UPDATE report_jobs SET status='expired' WHERE delivery='stream' AND status='ready'
      AND expires_at <= now()`);
  const stale = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE report_jobs j SET status='failed', error_code='BUILD_NOT_FINISHED'
    WHERE j.delivery='file' AND j.status IN ('queued','running') AND (
      j.created_at < now() - make_interval(hours => ${REPORT_BUILD_STALE_HOURS}::int)
      OR EXISTS (SELECT 1 FROM outbox_events e JOIN consumer_effects c ON c.event_id=e.id
        WHERE e.event_type='report.requested' AND e.aggregate_id=j.id::text
          AND c.consumer='report_builder' AND c.status='dead'))
    RETURNING j.id`);
  const filesToDelete = await db.$queryRaw<Array<{ id: string; key: string }>>(Prisma.sql`
    SELECT id, artifact_key AS key FROM report_jobs
    WHERE status='completed' AND expires_at <= now() ORDER BY expires_at LIMIT 500`);
  return { streamsExpired, staleIds: stale.map((row) => row.id), filesToDelete };
}

/** After its object is deleted: the job keeps its record, marked expired. */
export async function markReportFileExpired(db: Database, jobId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE report_jobs SET status='expired' WHERE id=${jobId}::uuid AND status='completed'`);
}
