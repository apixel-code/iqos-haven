# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-09
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 24 done + known-issue fixes, all merged to `main` (PR #1 `dba7acd`, PR #2 `674f52a`); M2 gate condition demonstrated locally and in CI
- Branch: `main` — start the next step from it (`step/25-email-adapter`)
- See docs/verification.md for actual checks.

## Next action

Run `/step 25`: email adapter + template pipeline (`EmailAdapter`, `EmailConsumer` as an `external` effect handler using Mailpit locally): stable delivery key (event/template/recipient), provider receipt stored via `external_receipt`, retries/duplicate-risk policy documented, `EMAIL_SEND_ENABLED` default off in tests/staging (add adapter env schema + boolean parsing in the same change). Real provider/sender/recipients wait for BI-07 — build behind config with Mailpit only. Do not wire `email` into any event's required consumers until its first real use (step 78/92) with a backfill decision. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

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

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-09, merge + CI)

Done: remote `git@github-apixel:apixel-code/iqos-haven.git` (SSH alias for the apixel-code account; `gh` logged in as apixel-code). Repository made public by Marina because Actions created no runs while it was private. PR #1 (steps 18–24 + fixes) CI green → merged; PR #2 moved CI actions to Node 24 majors, CI green → merged; `main` push CI green at `674f52a`.

Files: `.github/workflows/ci.yml`, `docs/verification.md`, `PROGRESS.md`.

Tests: CI on GitHub Actions — unit 98, integration 68 (PostgreSQL 18 + Redis services); every run so far succeeded.

Open notes: the repository is public (client architecture/docs visible) — confirm with the client or find a private-CI path; Vercel/Render/Netlify checks appear on commits (external apps on the account, not part of this project's pipeline); `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19; merged step branches still exist on the remote.

## History (summary)

- 2026-10-08 known-issue fixes + bug log (7e879c5); first CI runs green.
- 2026-10-08 step 24: reconciler, audited replay, durable scheduler, colon-free job IDs, M2 gate demo (7769a8f).
- 2026-10-08 step 23: effect runner + DB-clock defaults (1781c95).
- 2026-10-08 step 22: leased outbox relay (85d0487).
- 2026-10-08 step 21: worker runtime, INFO-based noeviction monitor, BullMQ prefix/options, cache≠queue guard (0375223).
- 2026-10-08 step 20: atomic outbox writer + OutboxService in ReliabilityModule (b220ca5).
- 2026-10-08 step 19: outbox/effect schema with DB-enforced completion/dead/replay/prune rules + contracts event catalogue (702f11a).
- 2026-10-08 step 18: append-only audit log + AuditService (619b1fe); env setup, MinIO Chainguard images, turbo concurrency, db:migrate CLI fix.
- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
