# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-09
- Milestone: M3 — identity, permissions, admin access and basic settings (M0 review and M1 staging/fixtures still open)
- Step: 33 (password-reset request/consume + durable email) — done
- Branch: `step/33-password-reset` (based on local step 32 commit `1a58fea`; ensure step 32 is merged before merging step 33)
- See docs/verification.md for actual checks.

## Next action

Review/push step 33 and merge via PR after CI is green, with step 32 (`1a58fea`) merged first. Then implement `/step 34`: staff invitation request/acceptance, server-approved role, hashed single-use expiring/revocable tokens and safe worker email. Reuse the identity user-lock/session-revocation pattern and fail-closed endpoint limiter framework. Reset UI remains step 37. Configure separate `PASSWORD_RESET_KEYS` and `PASSWORD_RESET_ORIGIN` on API/worker for reset testing; empty keys intentionally return 503. Apply the additive migration through the normal release flow. No real identities or `.env` secrets changed here.

## Blockers

None for step 33 implementation (reset email delivery to real inboxes still needs the rest of BI-07; local/test use Mailpit). BI-11 blocks real Owner bootstrap (28). Email go-live needs the rest of BI-07 (verified Resend domain, sender address, new-order recipients). Audit retention/pruning needs BI-08. BI-07 is partially answered; the other BI items remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

- **M2 — PASSED 2026-10-09** (closed on Marina's approval). Gate: a synthetic event is written and processed by the worker; duplicate delivery and Redis job loss are recovered; tests send no real email. Evidence: `apps/worker/src/recovery.int.test.ts` "M2 gate" (queue obliterated → reconciler re-enqueue + duplicate original job → effect completed exactly once), `effects.int.test.ts` (5 concurrent duplicates apply once), real dev orphan recovered by the built worker (step 24 notes in docs/verification.md); email only to Mailpit/stubs. CI green on `main` at a2429f7 (run 37894960188) with all steps 18–26 merged. Not part of this gate: production queue Redis failover/restore drills (M11, after BI-06).
- M0, M1 and M3–M11: not passed.

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
- 26 — @ih/platform storage + HMAC service auth, API InternalService guard, MinIO least-privilege user, MinIO in CI — PR #6 (c786eda)
- 27 — identity schema, explicit Owner/Staff permission seeds, lockable-but-immutable roles — PR #7 (2bbe336)
- 28 — argon2id hasher, password policy, one-time Owner bootstrap CLI, owner-lock trigger — PR #8 (045b544)
- 29 — Caddy same-origin gateway, header stripping, `pnpm test:gateway` (29 checks) in verify/CI — PR #9 (d494dc0)
- 30 — login/logout/me, `__Host-ih_admin` sessions, AuthGuard — PR #10 (3254f93)
- 31 — deny-by-default global `AccessGuard` (`@Public`/`@InternalService`/`@Authenticated`/`@RequirePermission`), boot-time route check, DB-derived permissions, `@Serialize` field policy + contract parse — PR #12 (7654d35)
- 32 — Origin/Sec-Fetch-Site/JSON-only `onRequest` hook, `@ih/platform` local/Redis fixed-window limiters + `EndpointLimiter` (fail-closed vs local fallback), login limits, ADR 0005 — 1a58fea

- 33 — hashed 30-minute password reset, atomic password/session/sibling revocation + audit/outbox, purpose-keyed worker email, fail-closed reset limits and old-password login race fix (ADR 0006) — commit `step(33): password reset with durable email and atomic session revocation` on this branch

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-09, step 33)

Done: step 33 (ADR 0006), backend + durable email only. Frontend reset page is step 37.

- `POST /v1/auth/forgot`: strict bounded contract; generic accepted response for known/unknown/inactive/malformed identities; no cookie or secret returned; active users receive a 30-minute hashed verifier with atomic audit/outbox/email effect.
- `POST /v1/auth/reset`: generic failure; password-policy/NFKC validation; user lock + atomic single-use consumption, password/version update, all-session revocation, sibling-link invalidation and audit/outbox; no auto-login.
- Random UUID + purpose-keyed 256-bit secret; only hash in DB, IDs-only events. Dedicated API/worker key ring, configured admin origin, fragment link. Planner verifies recipient/hash/user/version/use/expiry; retained old keys reproduce the identical retry message. Empty keys fail closed with 503.
- Request limits IP 20/15m + identity 3/30m; consume IP 20/15m; authoritative limiter outages 503, denials 429 + Retry-After. Origin/JSON controls cover both endpoints.
- Review caught a concurrent old-password login that could commit behind reset revocation. `createSession` now locks/rechecks the same user before insert; deterministic real-DB lock-wait test passes. Second invariant review: no issues.
- Generated reset OpenAPI contracts; corrected stale README/start/status/security text. Frozen lockfile validated offline. Existing local dependency tree linked the new worker workspace dependency; no external package version changed.

Files: `packages/db/prisma/{schema.prisma,migrations/20261009120000_password_reset/migration.sql}`, `packages/db/src/{password-reset,sessions,index}.ts`, `packages/contracts/src/{auth,events,events.test}.ts`, `packages/platform/src/{index.ts,password/reset-token*}`, `packages/config/src/{index,index.test}.ts`, `packages/application/src/email/{index,password-reset}.ts`, `apps/api/src/auth/{auth.module,password-reset*}.ts`, `apps/api/src/security/limit-policies.ts`, `apps/worker/src/{main,password-reset-email*}.ts`, `apps/worker/package.json`, `pnpm-lock.yaml`, `.env.example`, `turbo.json`, `scripts/generate-api-contract.mjs`, `docs/api.openapi.json`, `docs/decisions/0006-password-reset-delivery.md`, `docs/{environment,email-delivery,implementation-status,task-backlog,security-boundaries,verification}.md`, `docs/runbooks/secrets-and-keys.md`, `README.md`, `START-HERE-BN.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 266, integration 139, gateway 29). New coverage: generic accounts, hash-only storage, 30-minute expiry, concurrent reuse and sibling invalidation, weak/NFKC passwords, all-session revocation, rollback on audit failure, blocked old-hash login, Origin/strict contracts/rate limits, missing reset config/shared Redis outage, real Mailpit delivery through EffectRunner, completed duplicate, old-key retry, stale/changed recipient suppression.

Unfinished: step 34 invites, step 35 staff admin, step 36 last-Owner service, step 37 auth/reset UI. Real email go-live still BI-07; key provisioning and migration are operator/release setup. No live DB migration, real email, PR push or merge performed. No new milestone gate closed.

## History (summary)

- 2026-10-09 step 32: Origin/CSRF/JSON controls, fail-closed/local-fallback limiters, login policies, ADR 0005 (1a58fea); verify unit 256/integration 128/gateway 29.

- 2026-10-09 step 31: deny-by-default AccessGuard, DB-derived permissions, `@Serialize` field policy (PR #12, 7654d35).
- 2026-10-09 step 30: admin sign-in/logout/me + session lifecycle, AuthGuard (PR #10, 3254f93); M2 gate closed (PR #11).

- 2026-10-09 step 29: Caddy same-origin gateway (PR #9, d494dc0).
- 2026-10-09 step 28: argon2id + one-time Owner bootstrap (PR #8, 045b544).
- 2026-10-09 step 27: identity schema + permission seeds (PR #7, 2bbe336).
- 2026-10-09 step 26: @ih/platform storage + service auth (PR #6, c786eda); Milestone 2 steps complete.
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
