import { toAuditEntry, type CommandContext } from "@ih/application";
import {
  defineEvent,
  reportJobSchema,
  reportParamsSchema,
  reportRequestSchema,
  type ReportJob,
  type ReportParams,
  type ReportRequest,
} from "@ih/contracts";
import {
  dubaiDate,
  dubaiDayRange,
  MetricRangeError,
  REPORT_LINK_MINUTES,
  REPORT_STREAM_MAX_ROWS,
  reportPermissions,
} from "@ih/domain";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

export class ReportForbiddenError extends Error {}
export class ReportNotFoundError extends Error {}
/** The command ID was already used for a different report. */
export class ReportConflictError extends Error {}

interface JobRow {
  id: string;
  type: string;
  params: unknown;
  delivery: "stream" | "file";
  status: string;
  estimatedRows: number;
  rowCount: number | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  live: boolean;
}
const JOB_COLUMNS = Prisma.sql`id, type, params, delivery, status,
  estimated_rows AS "estimatedRows", row_count AS "rowCount", error_code AS "errorCode",
  created_at AS "createdAt", completed_at AS "completedAt", expires_at AS "expiresAt",
  coalesce(expires_at > now(), false) AS live`;
function toJob(row: JobRow): ReportJob {
  return reportJobSchema.parse({
    id: row.id,
    type: row.type,
    report: { type: row.type, ...(row.params as object) },
    delivery: row.delivery,
    status: row.status,
    estimatedRows: row.estimatedRows,
    rowCount: row.rowCount,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    available:
      row.live &&
      ((row.delivery === "stream" && row.status === "ready") ||
        (row.delivery === "file" && row.status === "completed")),
  });
}
/** Stored parameters: the report without its type (the type has its own column). */
function storedParams(report: ReportParams): Record<string, string> {
  const { type: _type, ...rest } = report;
  return rest;
}
const sameRequest = (row: JobRow, report: ReportParams) =>
  row.type === report.type &&
  JSON.stringify(Object.entries(row.params as object).sort()) ===
    JSON.stringify(Object.entries(storedParams(report)).sort());

/** Rows the report will have, counted now: the size decides stream versus file. */
async function estimateRows(tx: Tx, report: ReportParams): Promise<number> {
  const count = async (sql: Prisma.Sql) =>
    (await tx.$queryRaw<Array<{ n: number }>>(sql))[0]?.n ?? 0;
  switch (report.type) {
    case "sales":
      return dubaiDayRange(report.from, report.to).days;
    case "orders": {
      // One row per order line (step 111 writes the item snapshots).
      const { start, end } = dubaiDayRange(report.from, report.to);
      return count(Prisma.sql`SELECT count(*)::int AS n FROM order_items i
        JOIN orders o ON o.id=i.order_id
        WHERE o.created_at >= ${start}::timestamptz AND o.created_at < ${end}::timestamptz`);
    }
    case "products":
      return count(Prisma.sql`SELECT count(DISTINCT product_id)::int AS n
        FROM product_sales_daily WHERE day BETWEEN ${report.from}::date AND ${report.to}::date
          AND delivered_units > 0`);
    case "inventory":
      return count(Prisma.sql`SELECT count(*)::int AS n FROM variants v
        JOIN products p ON p.id=v.product_id WHERE p.deleted_at IS NULL`);
    case "customers":
      return count(
        Prisma.sql`SELECT count(*)::int AS n FROM customers WHERE first_order_at IS NOT NULL`,
      );
  }
}

/**
 * Requests a report (roadmap step 110, ADR 0076). In one transaction: the requester's rights
 * (locked against deactivation and role change), the parameters, the size estimate, the job,
 * an audit entry and, for a file, `report.requested`. Up to `REPORT_STREAM_MAX_ROWS` rows the
 * job is `stream` and ready at once for 15 minutes; above it, a `file` queued for the worker.
 * The same command ID with the same report returns the existing job; with another, a conflict.
 */
export async function requestReport(
  db: Database,
  context: CommandContext,
  input: ReportRequest,
  /** Tests only: a lower stream limit, to exercise the file path without thousands of rows. */
  options: { streamMaxRows?: number } = {},
): Promise<{ job: ReportJob; created: boolean }> {
  const { commandId, report } = reportRequestSchema.parse(input);
  if ("from" in report) {
    dubaiDayRange(report.from, report.to); // MetricRangeError for an impossible or long range
    if (report.to > dubaiDate(new Date())) throw new MetricRangeError("The range ends after today");
  }
  const permissions = reportPermissions(report.type);
  return withTransaction(db, async (tx) => {
    let actorId: string;
    try {
      actorId = await lockCatalogueActor(tx, context.actorId, permissions, true);
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ReportForbiddenError();
      throw error;
    }
    const existing = async () =>
      (
        await tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT ${JOB_COLUMNS} FROM report_jobs
          WHERE requested_by=${actorId}::uuid AND command_id=${commandId}::uuid`)
      )[0];
    const replay = await existing();
    if (replay) {
      if (!sameRequest(replay, report)) throw new ReportConflictError();
      return { job: toJob(replay), created: false };
    }
    const estimatedRows = await estimateRows(tx, report);
    const delivery =
      estimatedRows <= (options.streamMaxRows ?? REPORT_STREAM_MAX_ROWS) ? "stream" : "file";
    const [row] = await tx.$queryRaw<JobRow[]>(Prisma.sql`
      INSERT INTO report_jobs (type, params, delivery, status, requested_by,
        required_permissions, command_id, estimated_rows, expires_at)
      VALUES (${report.type}, ${JSON.stringify(storedParams(report))}::jsonb, ${delivery},
        ${delivery === "stream" ? "ready" : "queued"}, ${actorId}::uuid, ${permissions}::text[],
        ${commandId}::uuid, ${estimatedRows},
        ${
          delivery === "stream"
            ? Prisma.sql`statement_timestamp() + make_interval(mins => ${REPORT_LINK_MINUTES}::int)`
            : Prisma.sql`NULL`
        })
      ON CONFLICT (requested_by, command_id) DO NOTHING
      RETURNING ${JOB_COLUMNS}`);
    if (!row) {
      // A concurrent request with the same command ID committed first.
      const raced = (await existing())!;
      if (!sameRequest(raced, report)) throw new ReportConflictError();
      return { job: toJob(raced), created: false };
    }
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(
        { ...context, commandId },
        {
          action: "report.requested",
          entity: { type: "report_job", id: row.id },
          after: { report, delivery, estimatedRows },
        },
      ),
    );
    if (delivery === "file")
      await new PrismaOutboxWriter().publish(
        tx,
        defineEvent("report.requested", row.id, { reportJobId: row.id }),
      );
    return { job: toJob(row), created: true };
  });
}

async function reader(db: Database | Tx, actorId: string) {
  try {
    await lockCatalogueActor(db, actorId, ["reports.read"], false);
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) throw new ReportForbiddenError();
    throw error;
  }
}

/** The requester's own 50 newest jobs (`reports.read`). Nobody sees another person's jobs. */
export async function listReportJobs(db: Database, actorId: string): Promise<ReportJob[]> {
  await reader(db, actorId);
  const rows = await db.$queryRaw<JobRow[]>(Prisma.sql`SELECT ${JOB_COLUMNS} FROM report_jobs
    WHERE requested_by=${actorId}::uuid ORDER BY created_at DESC, id DESC LIMIT 50`);
  return rows.map(toJob);
}

/**
 * One of the requester's own jobs (`reports.read`). Someone else's job is not found, exactly
 * like an ID that does not exist, so a guessed ID tells nothing.
 */
export async function readReportJob(
  db: Database,
  actorId: string,
  jobId: string,
): Promise<ReportJob> {
  await reader(db, actorId);
  const [row] = await db.$queryRaw<JobRow[]>(Prisma.sql`SELECT ${JOB_COLUMNS} FROM report_jobs
    WHERE id=${jobId}::uuid AND requested_by=${actorId}::uuid`);
  if (!row) throw new ReportNotFoundError();
  return toJob(row);
}

/** Parses stored parameters back into a typed report (for the generators of step 111). */
export const parseStoredReport = (type: string, params: unknown): ReportParams =>
  reportParamsSchema.parse({ type, ...(params as object) });
