# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-09
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 25 (email adapter + template pipeline) — done, BI-07 parts deferred
- Branch: `step/25-email-adapter` (from `main`)
- See docs/verification.md for actual checks.

## Next action

Run `/step 26`: object-storage adapter + private service-auth framework (S3-compatible client against local MinIO buckets `ih-quarantine`/`ih-media`/`ih-reports`; add S3_* env schema in the same change, move those variables from "reserved" in docs/environment.md; buckets private, short-lived signed URLs only, service credentials scoped per bucket; no public bucket policies). Add MinIO to CI if integration tests need it (Chainguard image pinned in infra/images.lock.json). Production provider is BI-06. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None closed. M2 gate condition (synthetic event processed by worker; duplicate delivery + Redis job-loss recovery; tests send no real email) is demonstrated locally and in CI (PR #1, run 37818768532); Milestone 2 still has steps 25–26 open. M0/M1 remain open.

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — 619b1fe
- 19 — `outbox_events`/`consumer_effects` with DB-enforced completion/dead/replay/prune rules; contracts event catalogue + `defineEvent` — 702f11a
- 20 — `EventWriter` port, `PrismaOutboxWriter`, API `OutboxService` (`ReliabilityModule`) — b220ca5
- 21 — worker runtime/shutdown, INFO-based noeviction + memory monitor, BullMQ options/prefix, cache≠queue guard — 0375223
- 22 — leased outbox relay (SKIP LOCKED claim, enqueue outside tx, stable job IDs, backoff) — 85d0487
- 23 — EffectRunner (lease claim, one-tx completion, retry/dead, heartbeat, external receipts), DB-clock timestamp defaults — 1781c95
- 24 — EffectReconciler, dead listing + audited replay, scheduled_runs + Scheduler, colon-free job IDs; M2 gate demo — 7769a8f
- fix — DB-clock completion for zero-consumer events, reconciler per-status query + indexes, loopback Redis guard (bug log in docs/verification.md) — 7e879c5
- ci — actions/checkout v7, setup-node v7, pnpm/action-setup v6 (Node 24 runtimes) — b31ad60 (PR #2)
- 25 — email pipeline (strict env, templates, delivery key, EmailConsumer, SMTP/disabled/allowlist adapters, Mailpit in CI) — uncommitted (commit `step(25)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-09, step 25)

Done: step 25; `invariant-reviewer`: no blockers; should-fixes applied (email test env refuses non-local SMTP, STARTTLS required for real relays, in-flight-send-after-lease-loss documented, partial rejection recorded in receipt) and nits (receipt keeps the full key, 530/535 retried, disabled-backlog documented). New deps: nodemailer 10.0.16 (+@types 8.0.2), zod in @ih/application. CI workflow gains a Mailpit service.

Files: `packages/config/src/{index,index.test}.ts`, `packages/application/src/email/*`, `packages/application/{package.json,src/index.ts}`, `apps/worker/src/{email,email.int.test,main}.ts`, `apps/worker/package.json`, `.github/workflows/ci.yml`, `turbo.json`, `.env.example`, `docs/{email-delivery,environment,README,verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 112, integration 73).

Unfinished: BI-07 (provider + idempotency, sender domain SPF/DKIM/DMARC, recipients, bounce/complaint webhooks); planners/templates arrive with their features (78, 92, 107; reset/invite with identity steps). Open notes from the previous session still apply (public repo, external deploy checks, Ubuntu 26 runner).

## History (summary)

- 2026-10-09 merged PR #1 (steps 18–24 + fixes) and PR #2 (CI actions → Node 24) after green CI; PROGRESS PR #3.
- 2026-10-08 known-issue fixes + bug log (7e879c5); first CI runs green.
- 2026-10-08 step 24: reconciler, audited replay, durable scheduler, colon-free job IDs, M2 gate demo (7769a8f).
- 2026-10-08 step 23: effect runner + DB-clock defaults (1781c95).
- 2026-10-08 step 22: leased outbox relay (85d0487).
- 2026-10-08 step 21: worker runtime, INFO-based noeviction monitor, BullMQ prefix/options, cache≠queue guard (0375223).
- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
