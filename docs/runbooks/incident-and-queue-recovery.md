# Incidents, queue recovery and provider outages

## Monitoring and alerts (step 125, ADR 0096)

The worker's `ops.monitor` job runs every minute. Each rule opens an alert in `ops_alerts`, logs it (`"ops alert"`, error level) and emails `OPS_ALERT_RECIPIENTS`. It reminds every `OPS_ALERT_REMINDER_HOURS` while the alert stays open, and sends "resolved" on the first clean check. Emails go straight to the provider, not through the outbox, because the outbox may be the problem. If the email fails, the log line is still written.

Before launch:

1. Set `OPS_ALERT_RECIPIENTS` to Apixel's ops address. In staging it must also pass `EMAIL_RECIPIENT_ALLOWLIST`.
2. Run `pnpm ops:test-alert` on the server and confirm the message arrived.
3. Set `SYNTHETIC_STOREFRONT_URL` / `SYNTHETIC_ADMIN_URL` to the public URLs.
4. Optionally set `SENTRY_DSN`.
5. The monitor runs inside the VPS, so it cannot report the VPS itself being down. Add an external uptime check (any free pinger) on the storefront home page that emails the same address.

| Alert                                      | Fires when                                                                           | First action                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `effects.backlog`                          | the oldest unfinished background effect is older than 5 min                          | Is the worker running? Check queue Redis; the reconciler re-enqueues from PostgreSQL (below)  |
| `effects.dead`                             | any effect is `dead`                                                                 | Read its `last_error` code; fix the cause; replay deliberately (below)                        |
| `inventory.ledger`                         | an option's stock differs from its movements                                         | Stop stock edits on it; reconcile with audited stock commands (§15)                           |
| `cache.publication`                        | a storefront cache invalidation waits over 60 s                                      | Check `API_INTERNAL_URL` and the worker's service key; the catalogue TTL bounds staleness     |
| `database.connections`                     | over 80 % of PostgreSQL connections in use                                           | Look for stuck transactions or a pool misconfiguration before raising limits                  |
| `redis.queue`                              | queue Redis unreachable, not `noeviction`, evicting, or above 90 % memory            | Restore the policy and memory; then reconcile (below)                                         |
| `checkout.errors`                          | over 2 % of checkout/quote requests failed with 5xx in 10 min (at least 20 requests) | Logs by request ID, Sentry if enabled. Expected rejections (sold out, coupon) are not counted |
| `api.ready`                                | twice in a row: the API is unreachable from the worker or not ready                  | `/v1/health/ready` on the server; database first                                              |
| `synthetic.storefront` / `synthetic.admin` | twice in a row: the age gate → shop journey or the admin sign-in page fails          | Gateway, TLS, the storefront/admin processes                                                  |

Alert emails and logs carry counts and durations only, never order, customer or token data.

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
