# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 19 (outbox/effect schema + event contracts) — done
- Branch: `step/19-outbox-schema` (stacked on `step/18-audit-log`; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 20`: `OutboxService` in `@ih/db` (+ application port) that writes an `outbox_events` row and its `consumer_effects` from `defineEvent()` (contracts) inside the caller's `withTransaction()` only (reuse `isUnitOfWork`, like `PrismaAuditWriter`); prove atomic rollback with a business mutation. Move `@ih/contracts` from db devDependencies to dependencies if imported by non-test code. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None. M0–M11 gates not claimed. M2 gate needs steps 19–24 (synthetic event processed by worker; duplicate delivery and Redis job-loss recovery demonstrated).

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — uncommitted (commit `step(19)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, step 19)

Done: step 19 schema + contracts; `invariant-reviewer` should-fixes applied (completion requires finished effects, no late effects, dead→pending/retry only with `replays` counter, lease cleared on finished/dead, `queued_at`, prune path). Unreleased outbox migration was regenerated after review (local dev DB rolled back and re-migrated). Trigger functions pin `search_path` at creation.

Files: `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261008153329_outbox/`, `packages/db/src/{outbox.int.test,test-schema,audit.int.test}.ts`, `packages/db/package.json`, `packages/contracts/src/{events,events.test,index}.ts`, `docs/{verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 85, integration 20).

Unfinished: writer (20), relay (22), runner (23), reconciler/replay command + scheduled_runs (24). Pruning maintenance role awaits BI-08.

## History (summary)

- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
