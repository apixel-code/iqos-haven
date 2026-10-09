# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-09
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 26 (object storage + private service auth) — done; Milestone 2 steps 18–26 all implemented
- Branch: `step/26-object-storage` (from `main`)
- See docs/verification.md for actual checks.

## Next action

Milestone 2 is implemented; decide on closing its gate (condition demonstrated locally + in CI) and record it. Then Milestone 3 — run `/step 27`: identity migrations (`staff_users`, `roles`, `permissions`, `role_permissions`, `sessions`) with explicit permission seeds; read the M3 Dependency/Gate lines first. BI-11 (Owner accounts/staff list) blocks bootstrap data (step 28), not the schema. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for step 27 (schema). BI-11 blocks real Owner bootstrap (28). Email go-live needs the rest of BI-07 (verified Resend domain, sender address, new-order recipients). Audit retention/pruning needs BI-08. BI-07 is partially answered; the other BI items remain open; M0 needs client decisions; M1 staging needs BI-06.

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
- 25 — email pipeline (strict env, templates, delivery key, EmailConsumer, SMTP/disabled/allowlist adapters, Mailpit in CI) — f35e3dc (PR #4)
- feat — Resend adapter, EMAIL_PROVIDER/RESEND_* config, BI-07 partial + ADR 0004 — PR #5 (c088bb9)
- 26 — @ih/platform storage + HMAC service auth, API InternalService guard, MinIO least-privilege user, MinIO in CI — uncommitted (commit `step(26)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-09, step 26)

Done: step 26 in new package `@ih/platform` (ESLint infra group; boundary probes 14). `invariant-reviewer`: no blockers; should-fixes applied (fail closed when a body's raw bytes are missing; nonce store shared via queue Redis SET NX EX, deny on outage) and nits (service/keyId signed, no live-nonce eviction, duplicate keys rejected, streamed bounded reads, upload prefix + type allowlist). Local `.env` S3 keys switched to the `ih_service` user (gitignored file). CI starts MinIO via `docker run` (service containers cannot take arguments).

Files: `packages/platform/**`, `packages/config/src/{index,index.test}.ts`, `apps/api/src/{bootstrap,app.module}.ts`, `apps/api/src/internal/*`, `apps/api/src/health/{health.test,health.int.test}.ts`, `apps/api/package.json`, `infra/minio/init-buckets.sh`, `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`, `turbo.json`, `eslint.config.mjs`, `scripts/check-boundaries.mjs`, `CLAUDE.md`, `docs/{environment,security-boundaries,verification,implementation-status,task-backlog}.md`, `docs/runbooks/secrets-and-keys.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 162, integration 79).

Unfinished: production storage provider, bucket encryption/versioning/lifecycle and IAM (BI-06); first internal route (step 52) and the worker's signed client; media consumer (49) and report storage (112) use this adapter later.

## History (summary)

- 2026-10-09 BI-07 partial (Resend) + Resend adapter (PR #5, c088bb9).
- 2026-10-09 step 25: email pipeline (PR #4, 5d66ade).
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
