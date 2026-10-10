# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M3 — identity, permissions, admin access and basic settings (M0 review and M1 staging/fixtures still open)
- Step: 37 (admin login/reset/invite + session-aware layout/navigation) — done; visual browser QA pending
- Branch: `step/37-admin-auth-ui` (based on local step 36 commit `ad21bda`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

Implement `/step 38`: store/contact/notification/WhatsApp settings schema and Owner-only API with strict validation, expected versions and atomic audit/outbox. Read the settings architecture/database contracts and BI-01/BI-07 first; keep unanswered real contact/sender/recipient values unset/configured rather than copying prototype values. Step 37 browser visual/interactive QA remains pending: enable Computer Use and verify desktop/mobile login, expired-session recovery, reset/invite fragment consumption and permission navigation against isolated synthetic accounts. Review/push completed branches through green CI in step order (32–37).

## Blockers

None for step 37 code implementation; browser visual/interactive QA blocked by unavailable browser surface/Computer Use permission. Step 38 schema/API can proceed without real contact inputs (identity email delivery to real inboxes still needs the rest of BI-07; local/test use Mailpit). BI-11 blocks real Owner bootstrap (28). Email go-live needs the rest of BI-07 (verified Resend domain, sender address, new-order recipients). Audit retention/pruning needs BI-08. BI-07 is partially answered; the other BI items remain open; M0 needs client decisions; M1 staging needs BI-06.

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

- 37 — admin auth/reset/invite forms, dynamic no-store session shell and permission navigation/direct-section gate, memory-only fragment capabilities, real gateway auth checks (ADR 0010); visual/interactive QA pending — commit `step(37): admin auth pages and permission-aware session layout`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 37)

Done: step 37 code (ADR 0010), real admin auth pages/session-aware shell/navigation. Browser visual/interactive QA remains pending; no M3 gate claim.

- `/login`, `/forgot`, `/reset`, `/invite/accept`: shared responsive prototype-based forms/tokens; no defaults/demo credentials; real same-origin JSON auth and generic errors/success. Pending, password confirmation, show/hide, invalid/missing links, retry/rate-limit/unavailable states. Reset/invite success redirects to login without auto-login.
- Fragment capabilities consumed once into memory refs and immediately removed from history; no query token support/storage/logging. Cookie stays HttpOnly; browser handles it. Auth requests no-store and timeout after ten seconds. Dynamic page/cache/referrer controls prevent protected/session/capability caching.
- Protected shell uses strict fresh `/me`; route/focus/visibility/minute rechecks abort superseded requests and suppress stale completion. Failed verification hides workspace; 401 redirects with expired notice; other failures show retry. Real logout clears/revokes session; no success claim on failure. Permission-derived navigation and direct-section denial never trust a client role. Operational bodies are honest placeholders.
- Reused self-hosted fonts and light/dark theme tokens; initial light document/theme toggle, responsive card/sidebar. Browser gateway origin required; no Next credential proxy/config secrets. New contracts dependency is a workspace link only. Invariant reviewer: no issues.

Files: `apps/admin/{package.json,next.config.ts,vitest.config.ts}`, `apps/admin/app/{layout.tsx,globals.css,(workspace)/**,login/page.tsx,forgot/page.tsx,reset/page.tsx,invite/accept/page.tsx}` (old foundation page replaced), `apps/admin/components/{auth-form,session-shell,workspace-section}.tsx`, `apps/admin/lib/{auth,auth.test,navigation,navigation.test}.ts`, `pnpm-lock.yaml`, `docs/decisions/0010-admin-auth-ui.md`, `docs/{implementation-status,task-backlog,security-boundaries,verification}.md`, `README.md`, `START-HERE-BN.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 295, integration 172, gateway 29); includes admin 13 new auth/navigation tests and production build/lint/typecheck/format/boundary/reference/infra/contract checks. Offline frozen lockfile check PASS. Nine additional production-page/gateway HTTP smoke checks PASS: pages/cache/referrer/no demo defaults, anonymous shell/no private profile, actual anonymous 401, Staff login/current grants, Owner endpoint 403, logout/revoked session. Final admin checks rerun after explicit initial theme and same-page fragment replacement handling. Temporary API used an isolated test schema with synthetic identities and disabled email; shutdown drops it.

Initial setup: offline install needed noninteractive CI mode; stale generated `.next/dev/types` from the old page were removed before a green build. Local production preview used explicit staging profile/HTTPS internal URL placeholder; browser requests still used gateway. No dependency versions changed. Browser visual/interactive checks NOT RUN: no browser connector and native Computer Use permission denied. No screenshots or interactive reset/invite/session recovery evidence claimed.

Unfinished: browser desktop/mobile/interactive QA; step 38 settings schema/API; operational UI/later roadmap. Real identities BI-11, email BI-07, infrastructure/recovery BI-06. No real email, live DB migration, `.env` secret changes, PR push/merge or milestone gate performed.

## History (summary)

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
