# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 23 (effect runner) — done
- Branch: `step/23-effect-runner` (stacked on steps 22 → 21 → 20 → 19 → 18; neither merged to `main` — no remote/CI yet)
- See docs/verification.md for actual checks.

## Next action

Run `/step 24`: `EffectReconciler` + `scheduled_runs` + dead-effect inspection/replay. Reconciler (periodic, leased/SKIP LOCKED): re-enqueue effects that are `pending`/`queued`/`retry` and due with no live lease, and `running` with an expired lease — using stable job IDs, without re-enqueueing live work; dispatch events stuck with expired relay leases. Permissioned, audited replay command (dead → pending/retry; `replays` counter) — the API part waits for RBAC, so expose it as an application/db command now. `scheduled_runs` table (unique job/slot, lease, catch-up of missed slots, Asia/Dubai). Demonstrate the M2 gate: duplicate delivery + Redis job loss recovery. Local dev DB has a real orphan (`manual-relay-check` effect `queued`, its job was deleted) — the reconciler should complete it. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

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
- 22 — leased outbox relay (SKIP LOCKED claim, enqueue outside tx, stable job IDs, backoff) — 85d0487
- 23 — EffectRunner (lease claim, one-tx completion, retry/dead, heartbeat, external receipts), DB-clock timestamp defaults — uncommitted (commit `step(23)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08, step 23)

Done: step 23; `invariant-reviewer`: no blockers; should-fixes applied (DB-clock due_at + retry delay margin, completion retry/receipt after external work, heartbeat staleness abort, crash-loop → dead at budget, unrecorded-failure outcome) and nits (code-only PermanentEffectError, statement timeout in completion). Full verify exposed a real clock-skew bug (Prisma client-side `@default(now())`); fixed with migration `20261008160845_db_clock_defaults` (`statement_timestamp()`, zero Prisma drift) and a schema-policy unit test. Tests now use a unique queue prefix (an earlier run had obliterated the dev `ih-effect-system-probe` queue — that orphan is left for the step-24 reconciler).

Files: `packages/db/src/{effect-runner,schema-policy.test,index}.ts`, `packages/db/prisma/{schema.prisma,migrations/20261008160845_db_clock_defaults/}`, `packages/application/src/{effects,index}.ts`, `apps/worker/src/{effects,effects.int.test,queue,main,relay.int.test}.ts`, `apps/worker/package.json`, `docs/{verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 92, integration 57); integration suites re-run twice, stable.

Unfinished: reconciler, replay command, scheduled_runs (24) → then M2 gate demonstration.

## History (summary)

- 2026-10-08 step 22: leased outbox relay (85d0487).
- 2026-10-08 step 21: worker runtime, INFO-based noeviction monitor, BullMQ prefix/options, cache≠queue guard (0375223).
- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
