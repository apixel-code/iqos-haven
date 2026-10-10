# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M4 — catalogue, variants, safe media and inventory (started; M3 gate not closed; M0 review and M1 staging/fixtures still open)
- Step: 41 (catalogue schema and constraints) — done
- Branch: `step/41-catalogue-schema` (stacked on local step 40 `4ed00a9`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

1. Ask Marina whether to merge PR #13 (step 32, CI green) and then push/PR/merge the stacked local branches `step/33-*` … `step/41-*` in order, each after green CI (none of 33–41 is pushed yet).
2. Then `/step 42`: Brands CRUD, ordering, active/trash/restore (`BrandsController` + admin UI). Use `catalog.read` and `catalog.write`/`catalog.trash` permissions with `@Serialize`. The repository bumps `version` and `updated_at`, and expected-version conflicts are handled. Trashing is reference-aware: block it while published products still use the brand. Add audit/outbox entries in the same transaction. Add allowed-, denied- and invalid-input int tests. Hard purge stays Owner-only (`catalog.purge`).

Carry forward manual UI QA from step 40. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

## Blockers

None for step 41 schema work. Real settings/coverage require BI-01/BI-03/BI-09 and remaining BI-07 inputs. New-password browser submission needs user handoff under Computer Use policy; real mobile interaction QA remains open. BI-11 blocks real Owner bootstrap; BI-06 blocks staging. No milestone gate changes.

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

- 39 — Dubai-only stable delivery areas and versioned flat fee/ETA API, disabled threshold, atomic audit/outbox and locked inactive-area selection denial (ADR 0012) — b0213a5

- 40 — real versioned settings/staff/invitation/delivery forms, session-safe drafts and conflict recovery; actual-origin browser checks and responsive layouts (ADR 0013), manual UI QA partial — 4ed00a9

- 41 — catalogue schema: normalized slugs + locked cross-table redirect claims, fils bounds, publish completeness, canonical option signatures, global SKU, one default/primary, ledger-only stock guard, RESTRICT FKs and no runtime DELETE/TRUNCATE — uncommitted (commit `step(41)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 41)

Done: step 41 catalogue schema (migration `20261010000400_catalogue`, Prisma models, `packages/db/src/catalogue.int.test.ts`). Picked up the uncommitted WIP from the previous session, verified it, and applied the `invariant-reviewer` should-fixes:

- a stock-ledger-only trigger (new variants start at zero; changes need the transaction-local `ih.stock_ledger` flag)
- runtime role denied DELETE/TRUNCATE on brands/categories/products/variants and TRUNCATE on the rest
- compare-at must be above base
- published requires a positive price, plus a puff count for disposables
- positive publish tests and a tighter asset-key regex

Service-layer duties (version/`updated_at`, image count, option membership, rename-reclaim of an own redirect) are recorded in the migration comment.

Files: `packages/db/prisma/{schema.prisma,migrations/20261010000400_catalogue/migration.sql}`, `packages/db/src/catalogue.int.test.ts`, `docs/{implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 316, integration 206, gateway 29).

Unfinished: PR #13 is open (CI green) but not merged. Steps 33–41 are committed only locally. Steps 40 and 37 still need manual UI QA. There is no catalogue data yet (business approval). The M3 gate is not closed.

## History (summary)

- 2026-10-10 step 40: permission-gated settings/staff/invitation/delivery forms, ADR 0013 (4ed00a9); verify unit 316/integration 191/gateway 29; manual mobile and new-password browser QA open.
- 2026-10-10 step 39: Dubai-only versioned areas/flat-fee/ETA API and shared-lock selection, ADR 0012 (b0213a5); verify unit 304/integration 191/gateway 29. BI-03 values unconfigured.

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
