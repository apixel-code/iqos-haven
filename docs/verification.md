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
