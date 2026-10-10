# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M3 — identity, permissions, admin access and basic settings (M0 review and M1 staging/fixtures still open)
- Step: 39 (Dubai delivery areas + one flat fee/ETA configuration) — done; step 37 visual browser QA pending
- Branch: `step/39-delivery-configuration` (based on local step 38 commit `be7b4e7`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

Implement `/step 40`: settings/staff/delivery-area admin forms using the real step-35/36/38/39 APIs and auth/RBAC acceptance. Read the roadmap, focused prototype-map symbols and ADRs 0008–0012; keep missing business values visibly unconfigured, use current versions and reload on conflict. Verify actual admin-origin sessions/permissions and desktop/mobile login/reset/invite/session recovery when Computer Use is available. Review/push completed branches through green CI in step order (32–39).

## Blockers

None for step 39 backend implementation or step 40 forms. Real settings need BI-01/BI-09 and remaining BI-07 contact, sender and recipient inputs; real delivery configuration needs BI-03. Step 37 browser QA remains blocked by unavailable browser surface/Computer Use permission. BI-11 blocks real Owner bootstrap; BI-06 blocks staging provisioning. No milestone gate changes.

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

- 33 — hashed 30-minute password reset, atomic password/session/sibling revocation + audit/outbox, purpose-keyed worker email, fail-closed reset limits and old-password login race fix (ADR 0006) — 5a425bf

- 34 — immutable 24-hour invitations, Owner-only issue/reissue/revoke, atomic acceptance with stored role/current inviter authority, common Owner guard, purpose-keyed durable worker email and fail-closed policies (ADR 0007) — c7b8386

- 35 — Owner-only bounded staff list/profile edit/deactivate, versions and last-Owner guard, atomic session/reset/invitation revocation + audit/outbox, identity-version login fence (ADR 0008) — ce7fa14

- 36 — shared identity transactions/last-Owner guard, fixed Owner/Staff role changes and reactivation, atomic session/capability cleanup + audit/outbox, recovery runbook (ADR 0009) — ad21bda

- 37 — admin auth/reset/invite forms, dynamic no-store session shell and permission navigation/direct-section gate, memory-only fragment capabilities, real gateway auth checks (ADR 0010); visual/interactive QA pending — f0071e8

- 38 — typed Owner-only settings read/replace API, unconfigured groups, versioned atomic audit/outbox and strict validation (ADR 0011) — be7b4e7

- 39 — Dubai-only stable delivery areas and versioned flat fee/ETA API, disabled threshold, atomic audit/outbox and locked inactive-area selection denial (ADR 0012) — commit `step(39): versioned Dubai delivery configuration and areas`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 39)

Done: step 39 Dubai-only areas and one flat delivery fee/ETA schema/API (ADR 0012). Real BI-03 values remain unconfigured; no prototype areas/fee/ETA seeded, no milestone gate claim.

- Owner-only `delivery.manage` bounded list/create/edit/configuration routes with strict contracts, no-store and fail-closed IP/actor mutation limits. Stable area code/ID/emirate, case-insensitive name uniqueness and expected-version updates; unchanged writes preserve metadata. Deactivate rather than delete. Configuration version 0 creates; null clears preserving history; free threshold only supports disabled null.
- Common Owner-role/actor locks recheck current authority. Each mutation saves metadata-only audit and IDs-only outbox atomically. DB enforces Dubai identity, name/code uniqueness, positive versions and strict integer-fee/ETA/off-threshold configuration. No audit/event configuration contents or network calls in transactions.
- Internal tracked-transaction selection locks configuration before area with FOR SHARE, returns versioned snapshot fields and rejects inactive/missing/non-Dubai areas or unconfigured policy. Later quote/order steps must take earlier resource locks and enforce re-acceptance. No public selection/checkout endpoint introduced.

Files: `packages/contracts/src/{delivery.ts,index.ts,events.ts,events.test.ts}`, `packages/domain/src/{delivery.ts,delivery.test.ts,index.ts}`, `packages/db/{prisma/schema.prisma,prisma/migrations/20261010000300_delivery_configuration/migration.sql,src/delivery.ts,src/index.ts}`, `apps/api/src/{delivery/**,app.module.ts,security/limit-policies.ts}`, `scripts/generate-api-contract.mjs`, `docs/api.openapi.json`, `docs/decisions/0012-delivery-configuration.md`, `docs/{implementation-status,task-backlog,security-boundaries,business-inputs,verification}.md`, `docs/runbooks/owner-and-data-bootstrap.md`, `README.md`, `START-HERE-BN.md`, `PROGRESS.md`.

Tests: final `pnpm verify -- --integration` PASS after the reviewed raw SQL uniqueness mapping fix (unit 304, integration 191, gateway 29), including production builds/lint/typecheck/format/boundary/reference/infra/contract checks; targeted API PASS (96 tests, 11 new). New tests cover strict Owner/Staff/anonymous access, unconfigured/no-seed state, integer fee/off threshold, unique/stable areas, pagination, concurrent edits/configuration, no-ops/null clear, audit/outbox rollback, real DB constraints, deterministic configuration/area shared-lock waits and actor-demotion race, limiter outage. Rename-collision regression now checks 409 with unchanged version/audit. Initial DTO typing fixed; invariant review found raw P2010/23505 mapping gap (fixed), second review: no issues.

Unfinished: step 40 admin forms/auth acceptance; step 37 browser desktop/mobile/interactive QA (surfaces unavailable/Computer Use denied); BI-03 approved real delivery data and other business/provisioning inputs. No live migration, `.env` changes, dependencies, real emails/identities, PR push/merge or M3 gate closure. Tests use isolated schemas/local sinks.

## History (summary)

- 2026-10-10 step 38: typed Owner-only versioned settings API and atomic metadata-only audit/IDs-only events, ADR 0011 (be7b4e7); verify unit 297/integration 180/gateway 29. Real settings unconfigured.

- 2026-10-10 step 37: admin auth/session-aware navigation, ADR 0010 (f0071e8); verify unit 295/integration 172/gateway 29 and nine gateway HTTP checks. Browser visual/interactive QA not run (unavailable surfaces/Computer Use denied).

- 2026-10-10 step 36: shared last-Owner guard + versioned fixed-role/reactivation commands and atomic capability cleanup, ADR 0009 (ad21bda); verify unit 282/integration 172/gateway 29.

- 2026-10-10 step 35: versioned staff list/profile/deactivate, last-Owner enforcement + atomic session/capability cleanup and login fence, ADR 0008 (ce7fa14); verify unit 278/integration 161/gateway 29.

- 2026-10-10 step 34: atomic staff invitations/acceptance + durable purpose-keyed email, common Owner guard, ADR 0007 (c7b8386); verify unit 274/integration 151/gateway 29.

- 2026-10-09 step 33: atomic hashed password reset + session revocation/durable email, old-password login race fixed, ADR 0006 (5a425bf); verify unit 266/integration 139/gateway 29.

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
