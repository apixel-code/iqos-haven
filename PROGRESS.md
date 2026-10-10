# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M4 — catalogue, variants, safe media and inventory (started; M3 gate not closed; M0 review and M1 staging/fixtures still open)
- Step: 47 (set stock + inventory UI) — done (browser QA not run)
- Branch: `step/47-inventory-ui` (stacked on local step 46 `0923c1f`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

1. **Marina:** merge PR #13 (step 32, CI green), then push → PR → green CI → merge `step/33-*` … `step/47-*` in order. None of 33–47 is pushed. The auto-mode classifier blocked Claude from running the merge chain ("merge without review"); Marina either merges herself or allows it.
2. Then `/step 48`: safe media upload. Check `rg -n "^| 48 " docs/roadmap.md` and the architecture §11 "Media upload" section for the scope.
   - `media_assets` migration.
   - Authenticated upload authorization with a quarantine key.
   - Presigned POST with a content-length range (`@ih/platform` storage, step 26), and size/type limits.
   - No public bucket.
   - Processing and readiness come in 49–50.

BI-02 also gates product publication (51) and the M4 gate. Browser QA is still open for the catalogue/stock screens (42–47) and the step 37/40 forms. Use node@24 PATH; start Docker Desktop before `pnpm infra:up`.

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

- 41 — catalogue schema: normalized slugs + locked cross-table redirect claims, fils bounds, publish completeness, canonical option signatures, global SKU, one default/primary, ledger-only stock guard, RESTRICT FKs and no runtime DELETE/TRUNCATE — f3fd9ba

- 42 — brand admin API/UI: versioned CRUD, keyset order, reference-aware soft trash/restore, Owner-only SEO, slug redirects, stable 409 reasons, case-insensitive names, published-needs-live-parent trigger (ADR 0014) — 231a726

- 43 — category admin API/UI on a shared brand/category repository and component: case-insensitive names, IN_USE trash refusal, category-namespace redirects (ADR 0014) — 9be9e18

- 44 — product admin API/UI: draft-first, typed disposable/kit specs, integer fils + compare-at, parent locks, ordered checks with PARENT_UNAVAILABLE/PUBLISH_REQUIREMENTS, read-only tax reference until BI-02 (ADR 0015) — 5e7cc51

- 45 — options/variants API + editor: product-lock serialized rules, exact canonical combinations, global SKUs, one active default, deactivate-only, product-level events (ADR 0016) — 6f93175

- 46 — append-only stock ledger with AFTER INSERT verify/apply trigger, trigger-depth stock guard, replay-safe adjustments, inventory list/history API, reconciliation query (ADR 0017) — 0923c1f

- 47 — set-stock against the seen balance (STOCK_CHANGED), set/adjust effects with cross-variant unique admin command IDs, admin Stock workspace (ADR 0017) — uncommitted (commit `step(47)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 47)

Done: step 47 (ADR 0017 extended).

- **Shared command path:** `packages/db/src/inventory.ts` now has `runStockCommand`, used by both `adjustStock` and `setStock`. It does the actor lock, a replay check before and after the row lock, the plan, the movement with its balance, and the audit (`command` kind, no note text).
- **`setStock`:** the expected balance must match the current one, otherwise `STOCK_CHANGED`. The delta is computed under the lock. The movement is `INITIAL_STOCK` only for a first positive count, otherwise `MANUAL`. A no-op records nothing.
- **Ledger effects:** `set` vs `adjust`. A partial unique index makes each admin command ID unique across variants and effects; it is in the unapplied step-46 migration.
- **API:** `POST /v1/admin/inventory/:variantId/set`.
- **Admin:** a Stock workspace with state tabs, search, add/remove/set forms (notes, per-action command ID that changes on edit) and history.
- **`invariant-reviewer`:** no blockers. Should-fixes done: initial-only-positive, catch fallback limited to initial, effect separation, UI ID/key/history. Test gaps covered.

Files: `packages/contracts/src/{inventory,index}.ts`, `packages/db/src/inventory.ts`, `packages/db/prisma/migrations/20261010000700_stock_movements/migration.sql`, `apps/api/src/inventory/*`, `apps/admin/{components/inventory-management.tsx,components/workspace-section.tsx,lib/inventory.ts,lib/inventory.test.ts,lib/management.ts}`, `docs/decisions/0017-stock-ledger.md`, `docs/{implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 333, integration 272, gateway 29).

Unfinished:

- Browser QA has not been run.
- Low-stock events and scheduled reconciliation are step 53.
- PR #13 and steps 33–47 are not merged or pushed; Marina has to do this.
- Migrations have not been applied to the dev database.

## History (summary)

- 2026-10-10 step 46: append-only stock ledger + inventory API (0923c1f); verify unit 331/integration 266/gateway 29.
- 2026-10-10 step 45: options/variants API + editor (6f93175); verify unit 331/integration 254/gateway 29.
- 2026-10-10 step 44: product admin API/UI, typed specs, read-only tax reference (5e7cc51); verify unit 328/integration 243/gateway 29.
- 2026-10-10 step 43: category admin on a shared brand/category module (9be9e18); verify unit 323/integration 230/gateway 29.
- 2026-10-10 step 42: brand admin API/UI, reference-aware trash, Owner-only SEO, published-needs-live-parent trigger, ADR 0014 (231a726); verify unit 322/integration 222/gateway 29.
- 2026-10-10 step 41: catalogue schema + review fixes (ledger-only stock guard, runtime DELETE/TRUNCATE revoked, publish completeness) (f3fd9ba); verify unit 316/integration 206/gateway 29.
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
