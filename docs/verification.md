# Verification evidence — corrected archive

Date: 2026-10-08. Toolchain: Node 24.19.0 and pnpm 10.28.0. Results are from the corrective workspace, not claims inherited from the original ZIP.

| Check                                         | Result                  | Scope                                                                                            |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| pnpm install --frozen-lockfile                | PASS                    | Exact manifests and committed lockfile agree                                                     |
| pnpm build                                    | PASS                    | 11 Turbo build tasks: shared packages and four apps; Prisma client generated                     |
| pnpm lint                                     | PASS                    | 17 Turbo tasks including dependency builds                                                       |
| pnpm typecheck                                | PASS                    | 17 Turbo tasks including dependency builds                                                       |
| pnpm test                                     | PASS                    | 34 unit/HTTP fixture tests across 6 tested packages/apps; 14 Turbo tasks including builds        |
| pnpm format:check                             | PASS                    | Uploaded architecture and prototypes intentionally excluded from reformatting                    |
| pnpm test:boundaries                          | PASS                    | 9 ESLint probes, including invalid relative/import and allowed domain access                     |
| pnpm test:infra                               | PASS                    | 3 MinIO initializer probes: success, alias retry bound and propagated bucket failure             |
| pnpm test:package                             | PASS                    | Reference documents, ordered 132-step roadmap and no prototype checkout/confirmation persistence |
| pnpm contracts:generate / contracts:check     | PASS                    | Implemented health routes/error schemas; formatter-stable drift check                            |
| Empty production migration with --allow-empty | PASS (expected refusal) | Exit 1 before connecting; cannot silently skip production migrations                             |
| Explicit empty development migration          | PASS                    | Exit 0 with scaffold-only explanation                                                            |
| Inline JavaScript syntax                      | PASS                    | Both HTML prototype scripts parsed with node --check                                             |
| Architecture byte equality                    | PASS                    | Latest attachment and docs/architecture.md identical                                             |
| Final ZIP integrity/source inclusion          | PASS                    | CRC verification; required sources/docs included; generated/dependency/secret/Git files excluded |

Latest architecture SHA-256: `0fa17ee36071a53bb203c16df72833c9799ed772ab910003a642754f9b74bd00`.

## Not run or not established

Docker/Compose service execution and real PostgreSQL/Redis integration were not run: this execution environment does not provide Docker or running database/queue services. Consequently the corrected real-database harness, full API/worker dependency lifecycle, provider deployment and runtime grant behavior must be verified locally/CI before accepting the M1 gate. MinIO image digests could not be retrieved from its registry; official release tags and source references are recorded in infra/images.lock.json. Those references still need a successful image pull and execution check.

CI YAML was updated, but no GitHub Actions run was triggered. No real customer email was sent. Commerce race/idempotency/outbox recovery, browser age/cache boundaries, accessibility/visual approval, capacity, staging, production security, backup restore and rollback are pending because the corresponding business modules/infrastructure are not implemented. RPO/RTO remain unmeasured targets.

No milestone gate is declared complete by this foundation suite. Run `pnpm verify -- --integration` after local infrastructure is available, then the feature-specific acceptance cases as implementation proceeds.

## Local infrastructure run — 2026-10-08 (macOS, Node 24.21.0, Docker 29.8.2, Compose v5.5.1)

| Check                           | Result | Scope                                                                                      |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| pnpm install --frozen-lockfile  | PASS   | Node 24.21.0 (Node 25 is rejected by `engines`)                                            |
| pnpm infra:up                   | PASS   | postgres, redis-queue, mailpit healthy; minio up; minio-init exit 0 with 3 private buckets |
| PostgreSQL init roles/databases | PASS   | `ih_owner`, `ih_app`, `ih_test`; `iqos_haven`, `iqos_haven_test`                           |
| pnpm verify -- --integration    | PASS   | All foundation checks plus `test:int` (db 3 tests, api 1 test) against real PG18/Redis     |
| pnpm dev full boot              | PASS   | API live/ready 200 (`database: up`, `queue: up`); storefront/admin pages and `/health` 200 |
| Worker lifecycle                | PASS   | Worker started on `ih-system`, clean SIGTERM shutdown on watch restart                     |

Fixes needed for this run: official MinIO images are no longer publicly pullable from quay.io or Docker Hub, so Compose now pins Chainguard's MinIO and minio-client (`-dev`, has `/bin/sh`) builds by digest (see `infra/images.lock.json`); `turbo.json` sets `concurrency` to 16 because `pnpm dev` starts 11 persistent tasks (default limit 10). Staging, CI run and production-provider checks remain not run.

## Step 18 — audit log (2026-10-08, local)

`pnpm verify -- --integration` PASS (domain 27, db 7 + 11 integration, api 10 unit). Integration applies the real migration into an isolated schema: append inside `withTransaction()`, rollback with the failed mutation, root client refused, UPDATE/DELETE/TRUNCATE rejected by trigger (`append-only`) even for the owner, CHECK constraints, runtime-role privileges revoked. `pnpm db:migrate` applied `20261008151215_audit_log` to local `iqos_haven`; as `ih_app`, INSERT/SELECT succeeded and UPDATE/DELETE/TRUNCATE returned permission denied (one `manual-check` row remains in the local DB by design).

Release note: the migration revokes privileges only from a role named `ih_app`. If staging/production use a different runtime role name, revoke UPDATE/DELETE/TRUNCATE on `audit_log` for it during provisioning; the trigger still blocks mutations either way. Also fixed: `pnpm db:migrate` could not locate the Prisma CLI (package `exports` resolve to type stubs); it now uses the declared bin.

## Step 19 — outbox/effect schema and event contracts (2026-10-08, local)

`pnpm verify -- --integration` PASS (contracts 30 unit; db 19 integration). Integration applies all migrations into an isolated schema and checks: uuidv7 event IDs, snapshotted effects, duplicate (event, consumer) rejected, immutable payload, relay bookkeeping allowed, no delete of incomplete events/effects, completion blocked by unfinished effects, no late effects on completed events, dead/replay rules, prune path for completed events, payload bounds. Local `iqos_haven` migrated; `prisma migrate diff` shows no drift (hand-written partial indexes are ignored by Prisma). Grants: `ih_app` has no TRUNCATE on either table and no DELETE on `consumer_effects`; pruning needs a dedicated maintenance role (BI-08).

## Step 20 — atomic outbox writer (2026-10-08, local)

`pnpm verify -- --integration` PASS (db 32 integration, api 11 unit). Integration: a command writing a stand-in business row + audit + event commits all together and rolls all back together; root client refused; forged/dropped consumers, stale schema version, wrong aggregate type, unknown type, invalid aggregate version and PII payload rejected with nothing persisted; zero-consumer events complete at write with `dispatched_at` NULL; two publishes in one command yield distinct events/effects.

## Step 21 — worker lifecycle (2026-10-08, local)

`pnpm verify -- --integration` PASS (worker 7 unit + 5 integration, config 7). Worker integration on real Redis/PostgreSQL with unique queues: job processed and stable job ID deduplicated while present; concurrency peak equals the configured 2; `stop()` resolves only after the active job finished; production startup refused on an evicting policy; runtime policy flip triggers `onFatal`. Built worker started and stopped with SIGTERM (exit 0) at three timings; all three landed after startup had completed, so the SIGTERM-during-startup path is covered by code review only.

## Step 22 — leased outbox relay (2026-10-08, local)

`pnpm verify -- --integration` PASS (worker 13 integration, 12 boundary probes). Integration on real PostgreSQL/Redis: job enqueued with stable ID and IDs-only data, effect queued, event dispatched and lease released; no transaction of the relay pool is open while enqueueing (`pg_stat_activity`); concurrent claims are disjoint (SKIP LOCKED); a live lease is not reclaimed, an expired lease is, and the re-enqueue deduplicates to one job; enqueue failure and a hanging enqueue both record `ENQUEUE_FAILED` with a backoff lease and dispatch later; completed/zero-consumer events never claimed; loop start/stop. Manual: an event inserted as `ih_app` in local `iqos_haven` was dispatched by the built worker in one attempt (that effect stays `queued` until the step-23 runner exists).

## Step 23 — effect runner (2026-10-08, local)

`pnpm verify -- --integration` PASS, and `turbo run test:int --force` passed twice more (worker 24, db 32, api 1). Worker integration on real PostgreSQL/Redis: side effect + completion + event completion commit together; 5 concurrent duplicate deliveries apply once; transient failure rolls back the side effect, schedules a stable retry job and early duplicates claim nothing; permanent and exhausted failures go dead with safe codes; expired running lease reclaimed and the stale runner cannot complete; crash loop goes dead at the budget; concurrent sibling effects complete the event; external work heartbeats, stores its receipt and aborts on lease takeover; writer → relay → queue → effect worker end to end. Tests use a unique BullMQ prefix (a sentinel key in the real `ih:` namespace survived the suite). Found and fixed: Prisma `@default(now())` used the Node clock, making fresh effects briefly unclaimable under Docker clock skew; migration `db_clock_defaults` moves defaults to PostgreSQL with no Prisma drift. Manual: a probe inserted as `ih_app` in local `iqos_haven` was completed by the built worker in one attempt.

## Step 24 — reconciler, replay, schedules; M2 gate demonstration (2026-10-08, local)

`pnpm verify -- --integration` PASS and one forced integration repeat (worker 35, db 32, api 1; unit 98). M2 gate demonstrated locally against real PostgreSQL/Redis: a synthetic `system.probe` event written by the outbox writer is dispatched by the relay, its Redis job is destroyed (queue obliterated), the reconciler re-enqueues it after the stale window, a duplicate copy of the original job is also delivered, and the effect completes exactly once (attempts 1) with the event completed; nothing remains stranded. No email exists or is sent. Also covered: live leases never re-enqueued, expired/overdue work recovered, bucketed reconcile IDs, dead listing without payloads, audited replay (reason required), missed-completion repair, scheduler slot uniqueness across two replicas, bounded catch-up after downtime, one-slot leases under slow runs, retry→failed, crash reclaim and crash-loop → failed. Manual: the built worker's reconciler recovered the real orphaned dev effect (`manual-relay-check`, job previously deleted) to completed. Found and fixed: BullMQ rejects custom job IDs with ":" beyond its 3-part legacy form, which had silently broken step-23 retry scheduling (masked by a fake enqueuer in tests); IDs are now colon-free and a test enqueues every ID form into real BullMQ. CI has not run (no remote).

## Known-issue fixes after step 24 (2026-10-08, local)

`pnpm verify -- --integration` PASS (unit 98, integration 68). Fixed: zero-consumer events now take `completed_at` from the database-generated `created_at` (no application clock left in outbox writes); reconciler query split per status (`UNION ALL`, merged oldest-due first) with new `consumer_effects_queued_idx`/`consumer_effects_running_idx` and the unused `consumer_effects_active_idx` dropped — `EXPLAIN` on local `iqos_haven` shows index scans for every branch, `prisma migrate diff` shows no drift; cache/queue Redis guard treats loopback aliases (`localhost`, `127.x`, `[::1]`) as one instance. Built worker on the dev stack: probe completed, no warnings/errors.

### Bug log (all found so far)

| Found   | Bug                                                                                | Fixed in                                   |
| ------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Setup   | Official MinIO images no longer pullable                                           | baseline (Chainguard, digest-pinned)       |
| Setup   | `pnpm dev` exceeded turbo concurrency 10                                           | baseline                                   |
| Step 18 | `pnpm db:migrate` could not resolve the Prisma CLI                                 | step 18                                    |
| Step 19 | Trigger functions resolved tables via caller `search_path`                         | step 19 (`SET search_path FROM CURRENT`)   |
| Step 23 | Integration tests obliterated the real dev effect queue                            | step 23 (unique test prefix)               |
| Step 23 | Prisma `@default(now())` used the app clock (fresh effects unclaimable under skew) | step 23 (`db_clock_defaults`)              |
| Step 24 | BullMQ rejected `:` job IDs beyond 3 parts; step-23 retry jobs silently failed     | step 24 (colon-free IDs, real-BullMQ test) |
| Post-24 | Zero-consumer events still used the app clock                                      | this fix                                   |
| Post-24 | Reconciler OR-query could not use partial indexes                                  | this fix (`reconciler_indexes`)            |
| Post-24 | Redis guard missed loopback aliases                                                | this fix                                   |

## First CI run — PR #1 (2026-10-08)

GitHub Actions run 37818768532 on `fix/known-issues` (PR #1 → `main`): PASS in 2m13s — install, format, build, lint, typecheck, unit (98: config 7, domain 32, db 8, logger 2, worker 7, contracts 31, api 11), boundaries, infra, package, contracts drift, integration on CI PostgreSQL 18 + Redis (68: api 1, db 32, worker 35, including the M2 gate recovery test). Runs were not created while the repository was private on the free plan without any visible error; they started after the repository was made public. Annotations: actions/checkout, setup-node and pnpm/action-setup v4 run on a deprecated Node 20 runtime (forced to Node 24); `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.

## Step 25 — email adapter and template pipeline (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 112, integration 73). Email integration against local Mailpit (also added to CI): one Bcc message per effect with `Message-ID`/`X-IH-Delivery-Key` = delivery key and receipt stored; duplicate delivery of a completed effect sends nothing; disabled adapter sends nothing yet completes; staging allowlist filters/suppresses; unreachable SMTP → retry. Unit: strict boolean/env safety rules, test env refuses non-local SMTP, HTML escaping, header-injection refusal, delivery key stability, permanent/partial classification. Built worker with the local `.env` logs "email sending disabled". No real email was sent.

## Resend adapter (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 130, integration 73). Resend adapter tested against a local stub of the batch API (no request reached api.resend.com): one email per recipient without Bcc, Idempotency-Key = delivery key, identical request on retry regardless of planner recipient order, >100 recipients split into stably keyed chunks, error classification (400/422/404/405 and idempotency conflict permanent; 401/403/409-concurrent/429/5xx and incomplete success bodies retried), provider messages never carried, abort honoured. Config: Resend needs a `re_…` key, an allowlist outside production, a local stub URL in tests, and https otherwise. No real email was sent; the sending domain is not verified yet (BI-07).
