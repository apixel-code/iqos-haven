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

## Triage (first 10 minutes)

1. Open the incident record: UTC time, alert name, release (image digest), what users see. IDs and counts only, never checkout data, tokens, links, provider errors or SQL.
2. `docker compose ps` (VPS service names from step 122): which service is down or restarting? `docker compose logs --since 15m <service>` and search by `requestId` / `effectId`.
3. Database first: `curl -fsS http://localhost:4000/v1/health/ready` on the server. If PostgreSQL is down, the API refuses writes safely; restore the database service before anything else. Accepted orders are only ever in PostgreSQL.
4. Then queue Redis, the worker, the storefront/admin and the gateway, in that order. A queue-degraded API keeps taking orders; their background work waits in PostgreSQL.

## Queue Redis lost, or the worker crashed

Orders, events and effects live in PostgreSQL; Redis jobs are disposable copies.

1. Bring queue Redis back with its policy: `docker compose exec redis-queue redis-cli CONFIG GET maxmemory-policy` must say `noeviction` (the worker refuses to start otherwise outside development).
2. Start the worker: `docker compose up -d worker`. Its reconciler finds unfinished effects whose lease expired and re-enqueues them with their stable IDs within a minute; effects still leased by a live worker are left alone.
3. Watch `effects.backlog` resolve. `pnpm launch:check` (read-only) shows the dead-effect count.
4. Never flush or delete `outbox_events` / `consumer_effects` rows, and never reset their status by SQL to "unstick" them.

## Dead effects (`effects.dead`)

An effect is dead when it failed permanently or used up its retry budget. It stays visible until someone acts.

1. `pnpm ops:effects` (optionally `--consumer email|media_processor|notification|storefront_revalidate`): ID, consumer, event type, attempts, replays and the error code. No payloads are shown.
2. The code says what to fix: `RETRY_EXHAUSTED:<cause>` means a dependency was down for the whole budget; a bare code (`SMTP_REJECTED`, `RESEND_BAD_BODY`, `ORDER_NOT_FOUND`, `INVALID_*`) is configuration or a defect. Email and media codes: see [email-delivery.md](email-delivery.md) and [uploads-and-media.md](uploads-and-media.md).
3. Fix the cause. Then replay each effect: `pnpm ops:effects --replay <id> --reason "INC-n: <what was fixed>"`. It moves dead → pending with a fresh attempt budget, writes `effect.replayed` to the audit log and the reconciler enqueues it. Replaying an effect that is not dead changes nothing.
4. A defect (`INVALID_*`, `UNEXPECTED_EVENT_TYPE`): do not replay; send the effect ID and code to Apixel. It stays dead and visible until a fix ships.

## Provider accepted, then the worker crashed

Email uses a stable provider idempotency key per effect, so the retry is deduplicated within the provider's window. Outside it, a duplicate internal email is possible and acceptable; never delete effect rows to avoid it. Database effects (notifications, rollups) complete in the same transaction as their write, so they cannot double.

## Checkout errors, limiter or cache trouble

`checkout.errors` counts only 5xx. Read the API logs by request ID. The checkout limiter falls back to bounded per-process limits if its shared store fails; sign-in fails closed. The catalogue cache refreshes within 60 s on its own; `cache.publication` means the worker cannot reach the API's internal invalidation (check `API_INTERNAL_URL` and the worker's service key).

## Stock ledger mismatch (`inventory.ledger`)

Stop stock edits on the named options. Find the cause in the audit log; correct only with an Inventory adjustment (reason required), which writes a ledger movement. Never update `variants.stock_on_hand` directly: the database refuses it anyway.

## Compromised accounts or keys

[staff-and-owner-recovery.md](staff-and-owner-recovery.md) for accounts, [secrets-and-keys.md](secrets-and-keys.md) and [age-ticket-keys.md](age-ticket-keys.md) for keys. Close the incident record with what was repaired, which effects were replayed (IDs), and follow-ups with an owner.
