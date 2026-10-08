# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 21 (queue connection + worker lifecycle) — done
- Branch: `step/21-worker-lifecycle` (stacked on steps 20 → 19 → 18; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 22`: leased outbox relay in `apps/worker` — claim due events with short leases via `FOR UPDATE SKIP LOCKED` in a short transaction, commit, then enqueue one job per pending effect with `createQueue()` (prefix `ih`) and stable job ID `effectJobId(eventId, consumer)`; set `queued`/`queued_at` and `dispatched_at` after enqueue (never hold a DB transaction across Redis calls). Select only `completed_at IS NULL` (zero-consumer events complete at write). Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None. M0–M11 gates not claimed. M2 gate needs steps 19–24 (synthetic event processed by worker; duplicate delivery and Redis job-loss recovery demonstrated).

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — 702f11a
- 20 — `EventWriter` port, `PrismaOutboxWriter`, API `OutboxService` (`ReliabilityModule`) — b220ca5
- 21 — worker runtime/shutdown, INFO-based noeviction + memory monitor, BullMQ options/prefix, cache≠queue guard — uncommitted (commit `step(21)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, step 21)

Done: step 21; `invariant-reviewer`: no blockers; should-fixes applied (startup/signal race, startup failure logged, bounded non-overlapping monitor) plus nits (`createQueue`, jobName in logs, stall/retry comments, best-effort guard docs). BullMQ prefix is now `ih` (old `bull:` keys in local Redis are irrelevant, jobs are disposable).

Files: `apps/worker/src/{main,queue,queue-policy,queue-policy.test,runtime,runtime.int.test}.ts`, `apps/worker/{package.json,vitest.int.config.ts}`, `packages/config/src/{index,index.test}.ts`, `.env.example`, `docs/{environment,verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 91, integration 38).

Unfinished: relay (22), runner (23), reconciler/replay/schedules (24). M2 gate not yet demonstrable.

## History (summary)

- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
