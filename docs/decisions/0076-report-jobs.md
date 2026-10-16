# 0076 — Report jobs: typed requests, requester scope, stream or file

- Date: 2026-10-16
- Status: accepted
- Step(s): 110 (generators: 111; storage, worker, download and UI: 112)

## Context

Roadmap step 110 has three done conditions:

- Typed parameters.
- Requester permission.
- A small export streams; a large one becomes a durable export.

Architecture §5 lists `report_jobs` (type, validated params, state, artifact key, requester, permission scope, created/completed/expires_at, error). Architecture §10 has the rules for reports:

- Small exports may stream; large ones become durable jobs.
- The requester and the current permission are checked again before a download.
- Links last 15 minutes at most.
- Customer exports are audited.
- A guessed job ID must never reveal someone else's report.

Architecture §14 keeps the prototype's five CSV reports, all Owner only, with the customer export permissioned separately. BI-08 keeps generated files for 7 days.

## Decision

**Every export request is a `report_jobs` row** (migration `20261016000400_report_jobs`). It belongs to the staff member who asked, and it is never deleted (DELETE is revoked from `ih_app`).

- **Fixed after the request** (trigger): type, parameters, delivery, requester, required permissions, command ID, estimate and creation time.
- **Statuses:**
  - A `stream` job is `ready` until it expires.
  - A `file` job goes `queued` → `running` → `completed` | `failed`, and later `expired`.
  - A finished job can only expire.
- **Rights for the download:** the job stores `required_permissions`. Every report needs `reports.export`; customers also needs `customers.export`. These are checked again at download (step 112).

**Typed parameters** (`reportParamsSchema`, a discriminated union):

| Report    | Parameters                                                     |
| --------- | -------------------------------------------------------------- |
| Sales     | `from`, `to`, `basis` (`booked` \| `delivered` \| `collected`) |
| Orders    | `from`, `to` (placement days)                                  |
| Products  | `from`, `to` (delivery days)                                   |
| Inventory | none (snapshot)                                                |
| Customers | none (snapshot)                                                |

Ranges are real Dubai days, at most 366, and end no later than today. Unknown fields are refused.

**Request.** `POST /v1/admin/reports` takes `{ commandId, report }` and needs `reports.export`. Everything below happens in one transaction:

1. **Rights:** the requester's rights are locked and checked (`FOR SHARE`, against deactivation and role change), including `customers.export` for the customers report.
2. **Command ID:** if the requester has used it before, the same report returns the existing job (200); a different report gets 409 `IDEMPOTENCY_CONFLICT`.
3. **Size estimate:** days for sales, order lines in the range for orders, products with deliveries in the range, variants for inventory, customers with an order.
4. **Delivery:**
   - Up to 5,000 rows (`REPORT_STREAM_MAX_ROWS`): a `stream` job, ready at once and expiring after 15 minutes.
   - Above that: a `file` job, queued, with a `report.requested` event.
5. **Audit:** an entry `report.requested` records the report, the delivery and the estimate.

A stream link that expired is not renewed by repeating its command ID: that returns the same job with `available: false`. A new link needs a new request with a new command ID.

**Status.** `GET /v1/admin/reports` (own 50 newest) and `GET /v1/admin/reports/:id` need `reports.read`. They return only the caller's own jobs. Someone else's job answers 404, exactly like an ID that does not exist. `available` is true only for a live `ready` stream or a live `completed` file.

**The event.** `report.requested` keeps no required consumer until step 112 adds `report_builder`. Backfill decision: the table is the queue of record, so step 112 also picks up jobs still `queued` from `report_jobs`.

## Alternatives considered

- **Stream without a job row.** Then there would be nothing to audit or scope by requester, and no 15-minute limit. Rejected.
- **Choose the delivery from the date range alone.** The orders and customers reports grow with the business, not with the range. Rejected.

## Consequences

- Step 111 writes the generators for the parameters stored here (`parseStoredReport`), and the streaming download for `stream` jobs.
- Step 112 adds the worker build of `file` jobs, private storage, signed download links (15 minutes), expiry cleanup, the download audit for customer data, and the Reports UI.
