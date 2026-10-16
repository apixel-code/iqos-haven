# 0078 — Built report files, signed downloads, expiry and the Reports screen

- Date: 2026-10-16
- Status: accepted
- Step(s): 112 (builds on ADRs 0076–0077)

## Context

Roadmap step 112 asks for private report storage, signed downloads and expiry cleanup. Its done conditions:

- The permission is checked again at download.
- Only the requester can download.
- The link lifetime is bounded.
- Staff cannot fetch a guessed job.

Architecture §10 limits links to 15 minutes. BI-08 keeps generated files for 7 days. ADR 0076 queues large reports as `file` jobs with `report.requested`, and makes `report_jobs` the queue of record. ADR 0077 provides the generators and the streamed download.

## Decision

**Builder.** `report_builder` is now a required consumer of `report.requested`. It is an external effect handler with 5 attempts. For each event:

1. **Claim:** `buildReportFile` claims the job (`queued`/`running` → `running`, counting attempts). A job in any other state is skipped.
2. **Check:** the requester must still be active and hold every one of the job's required rights. If not, the job fails with `REQUESTER_FORBIDDEN` and no file is made.
3. **Build:** the CSV is built in one repeatable-read snapshot with the step 111 generators. More than 200,000 data rows fails the job with `REPORT_TOO_LARGE`.
4. **Upload:** outside any transaction, to the private reports bucket at a fixed key, `reports/<job id>.csv`. A repeated build overwrites the same object.
5. **Record:** `completeReportFile` records the key, the row count and the size. It takes effect only while the job is `running`, and the file expires after 7 days. A redelivered effect is a duplicate and changes nothing.

**Download.** `GET /v1/admin/reports/:id/download` (`reports.export`) serves both kinds of job:

- **Stream job:** the CSV directly (ADR 0077).
- **File job:** `issueReportFileDownload` checks four things, then audits `report.downloaded`. Only after that does the API sign a 5-minute link (`REPORT_FILE_LINK_SECONDS`, within the 15-minute limit) and answer 303 to it, with `no-store` and `no-referrer`.
- **The four checks:** the job is the caller's own (otherwise 404, the same as an unknown ID); the caller still holds every required right (403); the job is `completed`; and it is not expired (409 `REPORT_NOT_AVAILABLE`).
- **No link without an audit:** a refusal signs nothing and audits nothing. The bucket refuses unsigned reads.

**No file without its job.**

- A job that fails also loses any object an earlier attempt stored.
- A build whose job was finished by someone else during the upload deletes its object, unless the job is `completed`. In that case another delivery recorded the same object, and it stays.
- Upkeep deletes the objects of jobs it gives up on.

**Logs.** The API's request log keeps only the response status. The logger also redacts a `Location` header, so a signed link never reaches the logs.

**Upkeep.** `reports.upkeep` runs every 15 minutes:

- Stream jobs past their time become `expired`.
- File jobs still `queued`/`running` whose effect is dead, or that are older than 6 hours, become `failed` with `BUILD_NOT_FINISHED`, so nothing waits forever.
- Completed files past 7 days are deleted from storage and only then marked `expired`. A failed delete is retried on the next run. The job record and its audit entries stay.

**Backfill.** Events written in step 110 kept an empty consumer set. No deployment ran step 110, and the upkeep fails any file job that was left queued.

**Reports screen** (`reports.read`; requesting needs `reports.export`):

- **Requesting:** the form takes the five reports with typed fields (range, and the sales basis), using Dubai days. The orders and customers reports ask for confirmation first, because they contain names and phone numbers. Each request carries a command ID, and a retried request keeps the same one.
- **The list:** shows only the caller's own reports, with their status, rows and expiry. It refreshes itself while something is being built. Download is a plain link to the API route, so every click is checked again.
- **Storage:** nothing is stored on the device.

## Consequences

- Step 114's acceptance pass covers the whole path; this step's evidence is in docs/verification.md.
- Local MinIO keeps report objects from test and QA runs until they are cleaned up by hand: their schemas are dropped, so the upkeep never sees them.
- `.order-table-wrap` is `position: relative` and `.dashboard` columns are `minmax(0, 1fr)`. Without these, a wide table or a visually hidden header widened the page at 390px; the browser pass caught it.
