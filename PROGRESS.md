# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 24 done + known-issue fixes; M2 gate condition demonstrated locally
- Branch: `fix/known-issues` (stacked on `step/24-reconciler-schedules` → … → 18; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 25`: email adapter + template pipeline (`EmailAdapter`, `EmailConsumer` as an `external` effect handler using Mailpit locally): stable delivery key (event/template/recipient), provider receipt stored via `external_receipt`, retries/duplicate-risk policy documented, `EMAIL_SEND_ENABLED` default off in tests/staging (add adapter env schema + boolean parsing in the same change). Real provider/sender/recipients wait for BI-07 — build behind config with Mailpit only. Do not wire `email` into any event's required consumers until its first real use (step 78/92) with a backfill decision. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None closed. M2 gate condition (synthetic event processed by worker; duplicate delivery + Redis job-loss recovery; tests send no real email) is demonstrated locally (docs/verification.md, step 24) but not yet in CI; Milestone 2 still has steps 25–26 open. M0/M1 remain open.

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — 702f11a
- 20 — `EventWriter` port, `PrismaOutboxWriter`, API `OutboxService` (`ReliabilityModule`) — b220ca5
- 21 — worker runtime/shutdown, INFO-based noeviction + memory monitor, BullMQ options/prefix, cache≠queue guard — 0375223
- 22 — leased outbox relay (SKIP LOCKED claim, enqueue outside tx, stable job IDs, backoff) — 85d0487
- 23 — EffectRunner (lease claim, one-tx completion, retry/dead, heartbeat, external receipts), DB-clock timestamp defaults — 1781c95
- 24 — EffectReconciler, dead listing + audited replay, scheduled_runs + Scheduler, colon-free job IDs; M2 gate demo — 7769a8f
- fix — DB-clock completion for zero-consumer events, reconciler per-status query + indexes, loopback Redis guard (bug log in docs/verification.md) — uncommitted (commit follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, known-issue fixes)

Done: fixed all open issues found so far (full bug log in docs/verification.md): zero-consumer events use the DB clock; reconciler query per status with new partial indexes (migration `20261008170000_reconciler_indexes`, applied locally, no drift, EXPLAIN shows index scans) merged oldest-due first; Redis guard unifies loopback aliases. `invariant-reviewer`: no blockers; its ordering note applied.

Files: `packages/db/src/{outbox,reconciler}.ts`, `packages/db/prisma/migrations/20261008170000_reconciler_indexes/`, `packages/config/src/{index,index.test}.ts`, `docs/{verification,environment}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 98, integration 68).

Unfinished: same as step 24 (replay API/permission with RBAC, scheduled jobs in their steps, BI-08 pruning, CI once a remote exists). Deliberately not changed: `OutboxService`/`AuditService` construct their writers directly (reviewer nit; consistent pattern, no defect).

## History (summary)

- 2026-10-08 step 24: reconciler, audited replay, durable scheduler, colon-free job IDs, M2 gate demo (7769a8f).
- 2026-10-08 step 23: effect runner + DB-clock defaults (1781c95).
- 2026-10-08 step 22: leased outbox relay (85d0487).
- 2026-10-08 step 21: worker runtime, INFO-based noeviction monitor, BullMQ prefix/options, cache≠queue guard (0375223).
- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
