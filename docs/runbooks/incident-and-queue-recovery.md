# Incidents, queue recovery and provider outages

Status: procedure to exercise once durable effects are implemented. Current worker accepts only the named healthcheck system job; all business handlers are pending and unknown jobs fail explicitly.

## Triage

Record UTC time, release/profile, safe request/event/effect IDs, impacted endpoints and dependency health. Never copy raw checkout, token URLs, provider errors or SQL into incident notes. Check PostgreSQL first; if unavailable reject authoritative writes safely. Inspect pool waits/locks, queue memory/policy and oldest unfinished effect. API readiness being queue-degraded is not a reason to discard accepted orders.

## Redis loss / crashed worker

Preserve PostgreSQL orders/outbox/effects. Restore queue Redis with noeviction and configured durability. The reconciler finds unfinished effects with expired leases/heartbeats and recreates disposable jobs using stable IDs. Do not reset/delete effect deduplication rows or blindly clear the DB because broker jobs were lost. Active leased effects are not re-enqueued prematurely. Dead effects stay investigable, not completed; repair/replay is permissioned and audited.

## Provider accepted then consumer crashed

Use the stable provider idempotency key within its documented retention window. If unsupported/expired, inspect receipt/outcome and the bounded duplicate risk before replay. Database notifications/rollups still require unique effects and same-transaction completion. At-least-once email is not exactly-once delivery.

## Checkout/limiter/cache outage

Primary DB/age/session checks remain required. Shared checkout limiter may use bounded local IP/hashed-phone and per-instance global admission ceilings; auth endpoints fail closed if their configured authoritative limiter fails. Bound cache misses/concurrency and TTL cleanup; no queue Redis cache fallback. Alert on fallback and automatically restore shared primary when healthy.

## Media/email/report outage

Keep failed work durable, finite retry/attempt budgets, quarantine/private reports protected and current permissions rechecked. Email is not required for order commit; staging/restore sends stay disabled. Observe provider quotas/bounces; verify recipients before enabling sends. Reconcile only through domain commands, not ad-hoc stock/payment table updates.

## Staff/key compromise

Revoke affected sessions/streams and keys, follow secrets-and-keys runbook, preserve last active Owner through the common guard and audited recovery process. Investigate report access/exports and privacy retention. Update the incident record with repair, replay and reconciliation results plus follow-up ownership.
