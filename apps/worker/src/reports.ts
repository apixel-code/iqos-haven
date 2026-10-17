import { PermanentEffectError, type ExternalEffectHandler } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import {
  buildReportFile,
  completeReportFile,
  failReportFile,
  markReportFileExpired,
  reportArtifactKey,
  reportJobStatus,
  reportMaintenance,
  type Database,
} from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import type { ObjectStorage } from "@ih/platform";
import type { ScheduledJob } from "./scheduler";

/**
 * `report_builder` (roadmap step 112, ADR 0078): builds a queued file report and stores it in
 * the private reports bucket. Build (database snapshot) → upload (outside any transaction) →
 * record; the object key is fixed per job, so a redelivery overwrites and completes once. A
 * report that cannot be built for a lasting reason marks the job failed and completes.
 */
export function createReportBuilderConsumer(options: {
  db: Database;
  storage: ObjectStorage;
  log: Logger;
}): ExternalEffectHandler {
  const { db, storage, log } = options;
  return {
    kind: "external",
    consumer: "report_builder",
    maxAttempts: 5,
    async perform(context, signal) {
      const payload = EVENT_CATALOGUE["report.requested"].payload.safeParse(context.payload);
      if (!payload.success || context.schemaVersion !== 1 || context.aggregateType !== "report_job")
        throw new PermanentEffectError("INVALID_REPORT_EVENT");
      const jobId = payload.data.reportJobId;
      const build = await buildReportFile(db, jobId);
      if (build.outcome === "skip") return { receipt: `skipped:${build.status}` };
      if (build.outcome === "fail") {
        // An earlier attempt may have stored the file: a failed job keeps no file.
        await storage.delete("reports", reportArtifactKey(jobId));
        await failReportFile(db, jobId, build.code);
        log.info({ effectId: context.effectId, jobId, code: build.code }, "report not built");
        return { receipt: `failed:${build.code}` };
      }
      signal.throwIfAborted();
      const bytes = new TextEncoder().encode(build.text);
      await storage.put("reports", build.key, bytes, "text/csv; charset=utf-8");
      const recorded = await completeReportFile(db, jobId, {
        key: build.key,
        rowCount: build.rowCount,
        byteSize: bytes.byteLength,
      });
      if (!recorded) {
        // Finished meanwhile: completed by another delivery (the same object, keep it), or
        // failed by upkeep (then the file must not stay behind).
        const status = await reportJobStatus(db, jobId);
        if (status !== "completed") await storage.delete("reports", build.key);
        log.info({ effectId: context.effectId, jobId, status }, "report finished meanwhile");
        return { receipt: `finished:${status}` };
      }
      log.info(
        { effectId: context.effectId, jobId, rows: build.rowCount, bytes: bytes.byteLength },
        "report built",
      );
      return { receipt: `built:${build.rowCount}` };
    },
  };
}

/**
 * Report upkeep every 15 minutes: expire stream jobs, fail file jobs that never finished,
 * and delete files past their 7 days (BI-08) before marking them expired. One file that cannot
 * be deleted is retried next run and never blocks the rest.
 */
export function createReportUpkeepJob(options: {
  db: Database;
  storage: ObjectStorage;
  log: Logger;
}): ScheduledJob {
  const { db, storage, log } = options;
  return {
    name: "reports.upkeep",
    spec: { kind: "interval", everyMs: 15 * 60_000 },
    catchUp: 1,
    async run() {
      const { streamsExpired, staleIds, filesToDelete } = await reportMaintenance(db);
      let deleted = 0;
      let failed = 0;
      // A build that never finished may still have stored its object: remove it.
      for (const id of staleIds)
        await storage
          .delete("reports", reportArtifactKey(id))
          .catch((error: unknown) =>
            log.warn({ jobId: id, ...errorSummary(error) }, "stale report file delete failed"),
          );
      for (const file of filesToDelete) {
        try {
          await storage.delete("reports", file.key);
          await markReportFileExpired(db, file.id);
          deleted++;
        } catch (error) {
          failed++;
          log.warn({ jobId: file.id, ...errorSummary(error) }, "report file delete failed");
        }
      }
      log.info({ streamsExpired, stale: staleIds.length, deleted, failed }, "report upkeep");
    },
  };
}
