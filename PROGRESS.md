# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-11
- Milestone: M5 — age boundary and storefront browsing (started; M4 steps done, gate waits for BI-02; M3 gate not closed; M0 review and M1 staging/fixtures still open)
- Step: 55 (age-ticket signer/verifier, key ring, API AgeGuard) — done with BI-04 values as configuration; next is 56
- Branch: `step/55-age-ticket` (stacked on local `step/54-catalogue-acceptance`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: you are on `step/55-age-ticket`, which is clean. Steps 33–55 are local, stacked commits; only `main` (through step 31) is on GitHub.
- New work: branch the next step from `step/55-age-ticket`. Do not branch from `main` until the chain is merged.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.

1. **Marina merges on GitHub (her decision, 2026-10-10).** PR #13 (step 32) first, then `step/33-*` … `step/55-*` in order: push → PR → green CI → merge. Claude's merge chain was denied by the classifier twice; Claude can push branches and open PRs if asked.
2. **Then `/step 56` (accept/reject routes, routing gate, restricted page) — ask Marina first.** BI-04 is OPEN: minimum age and gate copy are unknown. Buildable without it: storefront route handlers that sign with `@ih/platform/age-ticket`, the `ih_age` cookie (Secure, HttpOnly, SameSite=Lax), safe local return URL, rejection cookie, Origin check and rate limit, `proxy.ts` gate, with placeholder copy.
   - Every later stock writer (orders, steps 75–76, 85–86) must call `publishLowStockCrossing` in its transaction (ADR 0023).
3. **Step 58 (store catalogue API) is the first cache reader.** Mark routes `@AgeVerified()` + `@Serialize`, send `Cache-Control: private, no-store` and `Vary: Cookie` on success, use `CatalogueCacheService.getOrLoad` with keys from validated input, and map `CacheOverloadedError` to 503 (ADR 0022, 0024).
4. **Local invalidation call:** to exercise the worker → API call in dev, set `INTERNAL_SERVICE_KEYS` and the worker's `INTERNAL_SERVICE_*` in `.env` (see `.env.example`). Without them the effect completes as `skipped:not_configured`.
5. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README). `/tmp/ih-qa` does not survive; reinstall `playwright-core` there (or any directory) and set `QA_PLAYWRIGHT_DIR`.

BI-02 gates real publication and the M4 gate.

## Blockers

BI-04 (OPEN) blocks the policy values of steps 55–57 (step 55 built with placeholders; production refuses the `unapproved` policy); BI-05 (OPEN) blocks step 57. BI-02 blocks real publication and so the M4 gate. Real settings/coverage require BI-01/BI-03/BI-09 and remaining BI-07 inputs. New-password browser submission needs user handoff under Computer Use policy; real mobile interaction QA remains open. BI-11 blocks real Owner bootstrap; BI-06 blocks staging. No milestone gate changes.

## Gates passed

- **M2 — PASSED 2026-10-09** (closed on Marina's approval). Gate: a synthetic event is written and processed by the worker; duplicate delivery and Redis job loss are recovered; tests send no real email. Evidence: `apps/worker/src/recovery.int.test.ts` "M2 gate" (queue obliterated → reconciler re-enqueue + duplicate original job → effect completed exactly once), `effects.int.test.ts` (5 concurrent duplicates apply once), real dev orphan recovered by the built worker (step 24 notes in docs/verification.md); email only to Mailpit/stubs. CI green on `main` at a2429f7 (run 37894960188) with all steps 18–26 merged. Not part of this gate: production queue Redis failover/restore drills (M11, after BI-06).
- M0, M1 and M3–M11: not passed. M4: all steps (41–54) done; the gate needs a real publish, which BI-02 blocks.

## Steps done

- Baseline … 40 — foundation, reliability (18–24, M2 PASSED), email/storage (25–26), identity/auth/RBAC/settings/delivery (27–40); commits on `main` (≤31, PR #1–#12) and local stacked branches 32–40 (`1a58fea`…`4ed00a9`).
- 41 — catalogue schema: normalized slugs + locked cross-table redirect claims, fils bounds, publish completeness, canonical option signatures, global SKU, one default/primary, ledger-only stock guard, RESTRICT FKs and no runtime DELETE/TRUNCATE — f3fd9ba
- 42 — brand admin API/UI: versioned CRUD, keyset order, reference-aware soft trash/restore, Owner-only SEO, slug redirects, stable 409 reasons, case-insensitive names, published-needs-live-parent trigger (ADR 0014) — 231a726
- 43 — category admin API/UI on a shared brand/category repository and component: case-insensitive names, IN_USE trash refusal, category-namespace redirects (ADR 0014) — 9be9e18
- 44 — product admin API/UI: draft-first, typed disposable/kit specs, integer fils + compare-at, parent locks, ordered checks with PARENT_UNAVAILABLE/PUBLISH_REQUIREMENTS, read-only tax reference until BI-02 (ADR 0015) — 5e7cc51
- 45 — options/variants API + editor: product-lock serialized rules, exact canonical combinations, global SKUs, one active default, deactivate-only, product-level events (ADR 0016) — 6f93175
- 46 — append-only stock ledger with AFTER INSERT verify/apply trigger, trigger-depth stock guard, replay-safe adjustments, inventory list/history API, reconciliation query (ADR 0017) — 0923c1f
- 47 — set-stock against the seen balance (STOCK_CHANGED), set/adjust effects with cross-variant unique admin command IDs, admin Stock workspace (ADR 0017) — 947f097
- 48 — media_assets + quarantine upload (signed POST policy, HEAD outside tx, ETag, eight-slot limit, public endpoint), media.uploaded (ADR 0018) — 16d3867
- 49 — media_processor consumer (magic/decoder/bomb/animation/APNG checks, Sharp WebP derivatives, ETag pin), backfill function, hourly quarantine cleanup with grace (ADR 0019) — 3e9b5f7
- 50 — product gallery: ready-asset-only attach (DB triggers both ways), 8/primary/order under product lock, removal frees slot, 10-min signed previews, admin Images card (ADR 0020) — 4bdbeed (+ a22ae8a browser-QA fix: stable product editor contract)
- 51 — readiness/publish/unpublish/trash/restore + Owner-only purge via SECURITY DEFINER function, published products stay publishable, admin Publishing card + Trash tab (ADR 0021) — 395ddd9; browser QA harness in `scripts/browser-qa/`
- 52 — catalogue cache owner: bounded LRU (entries/bytes/TTL ≤ 60 s), shared cache-Redis backend with local fallback, post-commit local invalidation, signed `/v1/internal/revalidate`, worker `storefront_revalidate` effect, storefront no-second-cache lint (ADR 0022) — 00e4bfc
- 53 — low-stock transitions: pure crossing rule, one IDs-only `inventory.low` event per crossing from stock commands and threshold edits under the variant lock, silent re-arm, zero never unpublishes, hourly ledger reconciliation job (ADR 0023) — 8adc131
- 54 — acceptance pass: `productAvailability` sold-out rule, cross-module API acceptance test, browser QA 32/32 with media + invalidation consumers — 5e65bda
- 55 — age ticket: Ed25519 `v1.kid.payload.signature` signer/verifier and key ring, `@AgeVerified()` API guard (403 `AGE_VERIFICATION_REQUIRED`, fail closed), private key storefront-only by schema, `pnpm age:keygen`, rotation runbook (ADR 0024; BI-04 values in config) — `step(55)` commit on `step/55-age-ticket`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`, `email`, `media_processor`, `storefront_revalidate`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-11, step 55)

Done:

- **Step 55 (ADR 0024)**, built without BI-04 on Marina's decision (2026-10-11):
  - `@ih/platform` `age/age-ticket.ts` (+ `@ih/platform/age-ticket` subpath): sign, verify, key ring, cookie reader.
  - `@ih/config`: verifier and signer fields, policy/TTL placeholders, deployed-environment rules, private key refused outside the storefront.
  - API: `AgeTicketVerifier`, `@AgeVerified()` in the global `AccessGuard`, 403 `AGE_VERIFICATION_REQUIRED`.
  - `pnpm age:keygen`, `docs/runbooks/age-ticket-keys.md`, admin launcher strips the signing key.
- **`invariant-reviewer`:** no blockers; both should-fixes and the nits are done.

Files: `packages/platform/src/age/`, `packages/platform/{package.json,src/index.ts}`, `packages/config/src/{index,index.test}.ts`, `packages/contracts/src/index.ts`, `apps/api/src/auth/{age,age.int.test,access,auth.module}.ts`, `apps/api/src/http/error.filter.ts`, `scripts/{age-keygen.mjs,next-app.cjs}`, `package.json`, `CLAUDE.md` (command list), `.env.example`, `docs/decisions/0024-age-ticket.md`, `docs/runbooks/age-ticket-keys.md`, `docs/{business-inputs,implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 396, integration 330, gateway 29).

Unfinished:

- PR #13 and steps 33–55 are not merged (Marina merges on GitHub).
- BI-04: approved policy version, lifetime, minimum age, gate copy, re-check frequency.
- No storefront gate routes or store endpoints yet (56, 58). Local `.env` has no age keys; run `pnpm age:keygen` when step 56 needs them.
- M4 gate not passed (BI-02). `inventory.low` has no consumer until step 92. Migrations are not applied to the dev database. Real mobile QA is not done.

## History (summary)

- 2026-10-11 step 54: catalogue/inventory acceptance pass (5e65bda); verify unit 381/integration 325/gateway 29; browser QA 32/32.
- 2026-10-11 step 53: low-stock transitions + reconciliation job (8adc131); verify unit 378/integration 321/gateway 29.
- 2026-10-10 step 52: catalogue cache owner + invalidation (00e4bfc); verify unit 362/integration 314/gateway 29.
- 2026-10-10 step 51: publication, trash/restore, purge (395ddd9) + browser QA 27/27 and harness (9f48d34); verify unit 346/integration 305/gateway 29.
- 2026-10-10 step 50: product gallery (4bdbeed) + browser QA fix (a22ae8a); verify unit 345/integration 293/gateway 29.
- 2026-10-10 step 49: media validation, Sharp derivatives, quarantine cleanup (3e9b5f7); verify unit 342/integration 286/gateway 29.
- 2026-10-10 step 48: quarantine media upload authorization (16d3867); verify unit 334/integration 280/gateway 29.
- 2026-10-10 step 47: set-stock + admin Stock workspace (947f097); verify unit 333/integration 272/gateway 29.
- 2026-10-10 step 46: append-only stock ledger + inventory API (0923c1f); verify unit 331/integration 266/gateway 29.
- 2026-10-08 … 10-10 steps 18–45: reliability foundation (audit/outbox/effects/worker/scheduler, M2 gate), email/storage/service auth, identity/sessions/RBAC/CSRF/limiters/reset/invites/staff/settings/delivery (M3 steps), catalogue schema, brands/categories/products/variants — details per step in docs/verification.md and git history.
