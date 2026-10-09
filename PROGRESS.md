# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-09
- Milestone: M3 — identity, permissions, admin access and basic settings (M0 review and M1 staging/fixtures still open)
- Step: 32 (Origin/CSRF controls + endpoint limiter framework) — done
- Branch: `step/32-origin-csrf-limiters` (from `main`)
- See docs/verification.md for actual checks.

## Next action

Merge the PR for `step/32-origin-csrf-limiters` once CI is green, then run `/step 33`: password-reset request/consume (`password_reset_tokens` migration, `PasswordResetController`). Use a generic response whether or not the account exists. The token is single-use, expires in 30 minutes and is stored hashed, and it is consumed atomically so concurrent reuse is rejected. Consuming it revokes all of the user's sessions. The reset email goes through the outbox/worker. Add fail-closed `EndpointLimitPolicy` entries for reset request and consume in `apps/api/src/security/limit-policies.ts` (ADR 0005). Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 32–33 (reset email delivery to real inboxes still needs the rest of BI-07; local/test use Mailpit). BI-11 blocks real Owner bootstrap (28). Email go-live needs the rest of BI-07 (verified Resend domain, sender address, new-order recipients). Audit retention/pruning needs BI-08. BI-07 is partially answered; the other BI items remain open; M0 needs client decisions; M1 staging needs BI-06.

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
- 32 — Origin/Sec-Fetch-Site/JSON-only `onRequest` hook, `@ih/platform` local/Redis fixed-window limiters + `EndpointLimiter` (fail-closed vs local fallback), login limits, ADR 0005 — uncommitted (commit `step(32)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-09, step 32)

Done: step 32 (ADR 0005).

- **Fastify `onRequest` hook:** every non-safe request needs the target surface's allowlisted Origin (`ADMIN_ORIGINS` / `STOREFRONT_ORIGINS`) or it gets a 403. A cross-site or same-site `Sec-Fetch-Site` gets a 403, and a non-JSON body gets a 415.
  - Paths are classified after decoding and slash collapsing. Unknown surfaces fail closed, and internal HMAC routes are exempt from the Origin rule.
- **`@ih/platform` limiters:** a partitioned, capped `LocalRateLimiter` with an overflow ceiling, a Redis Lua limiter, and an `EndpointLimiter` (keyed HMAC keys, ordered short-circuit, fail-closed or local fallback with a per-process ceiling).
- **Config:** `RATE_LIMIT_PROFILE` (budget or replicated) plus the key secret, key cap and max replicas.
- **Login limits** are counted before argon2 and reset on success: IP 30/15m, identity+network 10/15m, identity 50/h. Denials get a generic 429 with Retry-After; a fail-closed limiter outage gets a 503.
- `checkoutPolicy`/`quotePolicy` are defined for steps 75 and 76.
- `invariant-reviewer`: no blockers. All 6 should-fixes are applied: IP header validation, per-partition caps with throttled sweep, IP-first short-circuit, accepted lockout risk recorded in the ADR with a warn log, encoded-path bypass, and logging of reset failures. The nits are applied too.

Files: `packages/config/src/{index,index.test}.ts`, `packages/platform/src/{index.ts,rate-limit/*}`, `apps/api/src/security/*`, `apps/api/src/{bootstrap,app.module}.ts`, `apps/api/src/infra/{infra.module,tokens}.ts`, `apps/api/src/http/error.filter.ts`, `apps/api/src/auth/{auth.controller,auth.int.test,access.int.test}.ts`, `.env.example`, `turbo.json`, `docs/environment.md`, `docs/decisions/0005-csrf-origin-and-rate-limits.md`, `docs/{verification,implementation-status,task-backlog}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 256, integration 128, gateway 29).

Unfinished: password reset (33), invites (34), staff admin (35), last-Owner service (36), admin UI (37). Limit values must be verified in staging (M11). The production deploy must keep Nest private behind the gateway.

## History (summary)

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
