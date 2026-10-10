# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-11
- Milestone: M4 — catalogue, variants, safe media and inventory (started; M3 gate not closed; M0 review and M1 staging/fixtures still open)
- Step: 53 (variant low-stock transitions + durable events) — done; next is 54
- Branch: `step/53-low-stock` (stacked on local `step/52-catalogue-cache`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: you are on `step/53-low-stock`, which is clean. Steps 33–53 are local, stacked commits; only `main` (through step 31) is on GitHub.
- New work: branch the next step from `step/53-low-stock`. Do not branch from `main` until the chain is merged.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.

1. **Marina merges on GitHub (her decision, 2026-10-10).** PR #13 (step 32) first, then `step/33-*` … `step/53-*` in order: push → PR → green CI → merge. Claude's merge chain was denied by the classifier twice; Claude can push branches and open PRs if asked.
2. **Then `/step 54`: catalogue/inventory acceptance pass** (SKU conflicts, option sold-out, concurrent adjustments, safe purge/upload, cache propagation). Find the row with `rg -n "^| 54 " docs/roadmap.md`. It closes M4 only with BI-02 answered.
   - Every later stock writer (orders, steps 75–76, 85–86) must call `publishLowStockCrossing` in its transaction (ADR 0023).
3. **Step 58 (store catalogue API) is the first cache reader.** Use `CatalogueCacheService.getOrLoad`, build keys from validated input, run `AgeGuard` before the read, and map `CacheOverloadedError` to 503 (ADR 0022).
4. **Local invalidation call:** to exercise the worker → API call in dev, set `INTERNAL_SERVICE_KEYS` and the worker's `INTERNAL_SERVICE_*` in `.env` (see `.env.example`). Without them the effect completes as `skipped:not_configured`.
5. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README).

BI-02 gates real publication and the M4 gate.

## Blockers

None known for step 54 code/tests (grep `docs/business-inputs.md` at `/step 54`); BI-02 blocks the M4 gate itself. Real settings/coverage require BI-01/BI-03/BI-09 and remaining BI-07 inputs. New-password browser submission needs user handoff under Computer Use policy; real mobile interaction QA remains open. BI-11 blocks real Owner bootstrap; BI-06 blocks staging. No milestone gate changes.

## Gates passed

- **M2 — PASSED 2026-10-09** (closed on Marina's approval). Gate: a synthetic event is written and processed by the worker; duplicate delivery and Redis job loss are recovered; tests send no real email. Evidence: `apps/worker/src/recovery.int.test.ts` "M2 gate" (queue obliterated → reconciler re-enqueue + duplicate original job → effect completed exactly once), `effects.int.test.ts` (5 concurrent duplicates apply once), real dev orphan recovered by the built worker (step 24 notes in docs/verification.md); email only to Mailpit/stubs. CI green on `main` at a2429f7 (run 37894960188) with all steps 18–26 merged. Not part of this gate: production queue Redis failover/restore drills (M11, after BI-06).
- M0, M1 and M3–M11: not passed.

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
- 53 — low-stock transitions: pure crossing rule, one IDs-only `inventory.low` event per crossing from stock commands and threshold edits under the variant lock, silent re-arm, zero never unpublishes, hourly ledger reconciliation job (ADR 0023) — `step(53)` commit on `step/53-low-stock`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`, `email`, `media_processor`, `storefront_revalidate`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-11, step 53)

Done:

- **Step 53 (ADR 0023):**
  - `@ih/domain` `crossedIntoLowStock` / `isLowStock`.
  - `@ih/contracts`: `inventory.low` payload `{ variantId, cause }`; consumers stay planned (step 92).
  - `@ih/db`: `publishLowStockCrossing`, called by `runStockCommand` (adjust/set) and by the variant update on a threshold edit, both under the variant row lock.
  - Worker: hourly read-only `inventory.reconciliation` job.
- **`invariant-reviewer`:** no blockers, no should-fix.

Files: `packages/domain/src/{inventory,inventory.test,index}.ts`, `packages/contracts/src/events.ts`, `packages/db/src/{inventory,variants}.ts`, `apps/api/src/inventory/low-stock.int.test.ts`, `apps/worker/src/{inventory,main}.ts`, `docs/decisions/0023-low-stock-transitions.md`, `docs/{implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 378, integration 321, gateway 29).

Unfinished:

- PR #13 and steps 33–53 are not merged (Marina merges on GitHub).
- `inventory.low` has no consumer until step 92; step 92 must record its backfill decision.
- Nothing reads the catalogue cache until step 58; shared-Redis backend tested with a fake client only.
- BI-02 still blocks real publishing. Migrations are not applied to the dev database. Real mobile QA and reset/invite submission are not done.

## History (summary)

- 2026-10-10 step 52: catalogue cache owner + invalidation (00e4bfc); verify unit 362/integration 314/gateway 29.
- 2026-10-10 step 51: publication, trash/restore, purge (395ddd9) + browser QA 27/27 and harness (9f48d34); verify unit 346/integration 305/gateway 29.
- 2026-10-10 step 50: product gallery (4bdbeed) + browser QA fix (a22ae8a); verify unit 345/integration 293/gateway 29.
- 2026-10-10 step 49: media validation, Sharp derivatives, quarantine cleanup (3e9b5f7); verify unit 342/integration 286/gateway 29.
- 2026-10-10 step 48: quarantine media upload authorization (16d3867); verify unit 334/integration 280/gateway 29.
- 2026-10-10 step 47: set-stock + admin Stock workspace (947f097); verify unit 333/integration 272/gateway 29.
- 2026-10-10 step 46: append-only stock ledger + inventory API (0923c1f); verify unit 331/integration 266/gateway 29.
- 2026-10-08 … 10-10 steps 18–45: reliability foundation (audit/outbox/effects/worker/scheduler, M2 gate), email/storage/service auth, identity/sessions/RBAC/CSRF/limiters/reset/invites/staff/settings/delivery (M3 steps), catalogue schema, brands/categories/products/variants — details per step in docs/verification.md and git history.
