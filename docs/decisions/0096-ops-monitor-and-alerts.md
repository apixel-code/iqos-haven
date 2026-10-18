# 0096 — Built-in ops monitor, email alerts and optional error reporting

- Date: 2026-10-18
- Status: accepted
- Step(s): roadmap step 125 (architecture §15)

## Context

Architecture §15 lists the signals to watch: checkout errors, durable-work backlog and dead effects, stock ledger, queue Redis, database connections, availability and cache publication. It plans release-tagged Sentry and OpenTelemetry "to the approved backend", but no backend was approved. The store runs on one Hostinger VPS (BI-06).

**Marina's decision (2026-10-18):**

- build the monitoring into the product, with no new paid service;
- make Sentry optional (on only when a DSN is set);
- send alerts to Apixel's ops email.

## Decision

- **Monitor:** a worker job `ops.monitor` runs every minute on the durable scheduler.
  - **Signals it reads:**
    - **database:** oldest unfinished effect, dead effects, oldest open cache invalidation, ledger mismatches, connection use;
    - **queue Redis:** `INFO`;
    - **API:** a new signed `GET /v1/internal/ops` (worker service key) gives checkout/quote requests and 5xx over 10 minutes, plus readiness;
    - **synthetic journey:** age gate → accept → `/shop`, and the admin sign-in page, on the public URLs.
  - **Rules (thresholds from §15):**
    - `effects.backlog` (> 5 min);
    - `effects.dead` (> 0);
    - `inventory.ledger` (> 0);
    - `cache.publication` (> 60 s);
    - `database.connections` (> 80 %);
    - `redis.queue` (unreachable, not `noeviction`, evicting, > 90 % memory);
    - `checkout.errors` (> 2 % with at least 20 requests);
    - `api.ready`, `synthetic.storefront` and `synthetic.admin`: two failures in a row.
  - **Not counted:** while `CHECKOUT_SUBMISSION_ENABLED` is off, the order route's deliberate 503 is skipped. The zero-orders alert stays disabled (§15).
- **Alert state:** new table `ops_alerts`, one row per rule. The migration is additive.
  - Transitions are pure (`nextAlertState` in `@ih/domain`): open, remind every `OPS_ALERT_REMINDER_HOURS` (default 6), resolve.
  - Rows are locked in key order, so racing runs open an alert once.
  - The state lives in PostgreSQL because the queue Redis may be what failed.
- **Notices:**
  - Every notice is logged.
  - One email per run goes to `OPS_ALERT_RECIPIENTS`, sent straight through the worker's email adapter rather than the outbox.
  - Counts and durations only.
  - `pnpm ops:test-alert` proves the recipients and the sender before launch.
- **Error reporting:** `@ih/platform/error-reporting` (`@sentry/node` 11.3.0, on only with `SENTRY_DSN`).
  - **Sent:** API 5xx and uncaught errors in the API and worker.
  - **Not collected:** no default integrations, tracing or breadcrumbs, and `dataCollection` is all off.
  - **Scrubbed:** `beforeSend` keeps only the error type, code location, release, environment and service tag. Messages are replaced by `[redacted]`, matching the logs, which never carry messages.
  - It is a subpath export, so the storefront never loads it.
- **OpenTelemetry metrics and traces are not adopted.** On one VPS the pino logs (request IDs), the monitor and optional Sentry cover §15 without another backend. Revisit with a replicated profile.

## Consequences

- Operators get §15 alerts by email with no third-party service; Sentry can be added by setting one variable.
- The monitor runs inside the VPS, so a whole-VPS outage needs an external uptime pinger. The runbook asks for one.
- One `scheduled_runs` row per minute is added, as the idempotency cleanup already does. Pruning old runs is left to the retention work (BI-08).
- Checkout counters are per API process. Correct for the single-process VPS; a replicated profile must aggregate them.
