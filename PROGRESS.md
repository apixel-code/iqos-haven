# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 22 (leased outbox relay) — done
- Branch: `step/22-outbox-relay` (stacked on steps 21 → 20 → 19 → 18; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 23`: `EffectRunner` in `apps/worker` consuming `ih-effect-<consumer>` queues (job data `{eventId, effectId, consumer}`). Claim the effect with a lease (accept status `pending` or `queued` — a job can run before the relay marks it queued; also `retry`), skip if completed/skipped, heartbeat long work, write the consumer's DB effect + effect completion in one transaction (lock order: effect row, then event), complete the parent event when all effects are completed/skipped, transient failure → `retry` with backoff `due_at`, permanent → `dead` with `last_error`. Implement the `system_probe` consumer. Duplicate jobs must be safe. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None. M0–M11 gates not claimed. M2 gate needs steps 19–24 (synthetic event processed by worker; duplicate delivery and Redis job-loss recovery demonstrated).

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — 702f11a
- 20 — `EventWriter` port, `PrismaOutboxWriter`, API `OutboxService` (`ReliabilityModule`) — b220ca5
- 21 — worker runtime/shutdown, INFO-based noeviction + memory monitor, BullMQ options/prefix, cache≠queue guard — 0375223
- 22 — leased outbox relay (SKIP LOCKED claim, enqueue outside tx, stable job IDs, backoff) — uncommitted (commit `step(22)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, step 22)

Done: step 22; `invariant-reviewer`: no blockers; should-fixes applied (5 s enqueue timeout, stop batch before lease margin, unknown consumer logged as error) plus nits (no relay start during shutdown, lock-order comment, ESLint ban of `@ih/db/testing` outside integration tests with probes). Added test-only pool `searchPath` and `@ih/db/testing` export (`applyMigrations`).

Files: `packages/db/src/{outbox-relay,client,test-schema,index}.ts`, `packages/db/package.json`, `apps/worker/src/{relay,relay.int.test,queue,queues,main}.ts`, `apps/worker/package.json`, `eslint.config.mjs`, `scripts/check-boundaries.mjs`, `docs/{verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 91, integration 46, boundary probes 12).

Unfinished: effect runner (23), reconciler/replay/schedules (24). Local dev DB has one `manual-relay-check` probe effect in `queued` (a step-23 runner should complete it).

## History (summary)

- 2026-10-08 step 21: worker runtime, INFO-based noeviction monitor, BullMQ prefix/options, cache≠queue guard (0375223).
- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
