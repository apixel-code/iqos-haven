# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 20 (atomic event/effect writer) — done
- Branch: `step/20-outbox-writer` (stacked on `step/19-outbox-schema` → `step/18-audit-log`; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 21`: queue connection + standalone worker lifecycle (BullMQ). Much exists in `apps/worker` (noeviction check, bounded concurrency, shutdown) and is marked Partial; read `apps/worker/CLAUDE.md`, close the gaps against the step-21 done condition (queue Redis `noeviction`, bounded concurrency, clean shutdown, cache eviction policy never mixed), add tests. Then step 22 relay must select `completed_at IS NULL` (zero-consumer events are complete at write with `dispatched_at` NULL). Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None. M0–M11 gates not claimed. M2 gate needs steps 19–24 (synthetic event processed by worker; duplicate delivery and Redis job-loss recovery demonstrated).

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — 702f11a
- 20 — `EventWriter` port, `PrismaOutboxWriter`, API `OutboxService` (`ReliabilityModule`) — uncommitted (commit `step(20)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, step 20)

Done: step 20 writer; `invariant-reviewer`: no blockers, nits applied (same timestamp for created/completed on zero-consumer events, extra int tests). Renamed `apps/api/src/audit` → `apps/api/src/reliability` (`ReliabilityModule` provides `AuditService` + `OutboxService`). `@ih/contracts` is now a runtime dependency of `@ih/db`, `@ih/application` and `@ih/api`.

Files: `packages/db/src/{outbox,outbox-writer.int.test,index}.ts`, `packages/db/package.json`, `packages/application/src/{events,index}.ts`, `packages/application/package.json`, `apps/api/src/reliability/*`, `apps/api/src/app.module.ts`, `apps/api/package.json`, `docs/{verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 86, integration 33).

Unfinished: relay (22), runner (23), reconciler/replay/schedules (24); writer is not yet called by any business command (first callers arrive with identity/catalogue steps).

## History (summary)

- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
