# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M3 — identity, permissions, admin access and basic settings (M0 review and M1 staging/fixtures still open)
- Step: 34 (staff invitation issue/revoke/accept + durable email) — done
- Branch: `step/34-staff-invitations` (based on local step 33 commit `5a425bf`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

Review/push step 34 and merge via PR after CI is green, with steps 32–33 merged first. Then implement `/step 35`: Owner-only staff list/edit/deactivate with strict contracts, versions, fresh permission checks, audit/outbox and all-session revocation. Retain Owner-role → sorted staff-row lock order and last-active-Owner protection; step 36 completes the shared fixed-role administration service. Do not let staff administration resurrect users through invitations. Backend auth UI remains step 37. Invitation activation requires the additive migration and independent API/worker `STAFF_INVITATION_KEYS` / `STAFF_INVITATION_ORIGIN`; empty keys disable issue/accept (503), while revoke remains available. No real identities or `.env` secrets changed here.

## Blockers

None for step 34 implementation (identity email delivery to real inboxes still needs the rest of BI-07; local/test use Mailpit). BI-11 blocks real Owner bootstrap (28). Email go-live needs the rest of BI-07 (verified Resend domain, sender address, new-order recipients). Audit retention/pruning needs BI-08. BI-07 is partially answered; the other BI items remain open; M0 needs client decisions; M1 staging needs BI-06.

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

- 34 — immutable 24-hour invitations, Owner-only issue/reissue/revoke, atomic acceptance with stored role/current inviter authority, common Owner guard, purpose-keyed durable worker email and fail-closed policies (ADR 0007) — commit `step(34): staff invitations with atomic acceptance and durable email` on this branch

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 34)

Done: step 34 (ADR 0007), backend + durable email. Invitation page is step 37.

- `POST /v1/admin/staff/invitations` and `/revoke`: `staff.manage` only (Owner launch grant); strict contracts, no-store, separate fail-closed management budgets. Issue returns ID/expiry, never a token. Resend atomically revokes the prior pending row with audit/outbox. Revoke is idempotent and remains available with delivery keys missing.
- `POST /v1/auth/invite/accept`: public same-admin-Origin JSON flow with fail-closed IP limiter; generic failures; NFKC/password policy; no auto-login. Immutable saved email/name/role/actor, not invitee input. 24-hour hashed single-use token, accepted/revoked state constraints, partial unique pending-email index, immutable snapshot trigger/version.
- All invitation mutations take Owner-role → inviter → invitation/new staff locks. Fresh active/staff.manage authority checks repeat inside the transaction, including acceptance. Account creation/consumption/audit/outbox commit together; existing/inactive accounts are never overwritten/reactivated. Common guard protects new Owner membership. Hashing and email stay outside transactions.
- Independent `STAFF_INVITATION_KEYS` / `STAFF_INVITATION_ORIGIN`; IDs-only event, hash-only verifier, stable old-key retry, `/invite/accept#token=...`. Worker refuses expired/accepted/revoked/unauthorized/existing-account links. Email default-off/staging allowlist policy unchanged.
- New OpenAPI invitation contracts and cookie scheme; ADR/config/email/key runbooks updated. No historical consumer backfill needed. Invariant reviewer: no issues.

Files: `packages/db/prisma/{schema.prisma,migrations/20261010000100_staff_invitations/migration.sql}`, `packages/db/src/{staff-invitations,index}.ts`, `packages/contracts/src/{auth,events,events.test}.ts`, `packages/platform/src/{index.ts,password/invitation-token*}`, `packages/config/src/{index,index.test}.ts`, `packages/application/src/email/{index,staff-invitation}.ts`, `apps/api/src/auth/{auth.module,staff-invitation*}.ts`, `apps/api/src/security/limit-policies.ts`, `apps/worker/src/{main,staff-invitation-email*}.ts`, `.env.example`, `turbo.json`, `scripts/generate-api-contract.mjs`, `docs/api.openapi.json`, `docs/decisions/0007-staff-invitations.md`, `docs/{environment,email-delivery,implementation-status,task-backlog,security-boundaries,verification}.md`, `docs/runbooks/secrets-and-keys.md`, `README.md`, `START-HERE-BN.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 274, integration 151, gateway 29), including build/lint/typecheck/format/boundary/reference/infra/contract checks. API 9 new tests cover Owner/Staff/anonymous permissions, strict input/role control, hash-only 24-hour snapshots, 5 concurrent accepts → exactly one account, reissue/revoke, existing/deactivated accounts, expiry/tampering/inactive inviter/weak and NFKC passwords, snapshot immutability, atomic issue/accept audit rollback, deterministic Owner-guard wait then revocation rejection, 3 concurrent resends → one pending row, direct repository Staff denial, Origin/429/503 policies. Worker 3 new tests cover real Mailpit/EffectRunner delivery, completed duplicate, stable old-key retry, obsolete/unauthorized/existing-recipient suppression, missing-key retry and event ownership denial. Unit tests cover purpose separation and config.

Unfinished: step 35 staff administration, step 36 last-Owner service, step 37 auth/reset/invite UI. Migration/key provisioning are operator/release setup; real identities BI-11 and email BI-07. No live DB migration, real email, PR push/merge or new milestone gate performed.

## History (summary)

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
