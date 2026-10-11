# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-11
- Milestone: M5 — age boundary and storefront browsing: all steps (55–64) done; gate demonstrated locally with seeded data, awaiting Marina's decision. M4 steps done, gate waits for BI-02; M3 gate not closed; M0 review and M1 staging/fixtures still open
- Step: 64 (store shell, WhatsApp links, age-boundary verification) — done; next is 65 (M6)
- Branch: `step/64-shell-gate-verification` (stacked on local `step/63-device-lists`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: you are on `step/64-shell-gate-verification`, which is clean. Steps 33–64 are stacked branches, all pushed to GitHub on 2026-10-11 (no PRs opened for 33–64 yet); `main` holds steps through 31 and PR #13 is step 32.
- New work: branch the next step from `step/64-shell-gate-verification`. Do not branch from `main` until the chain is merged.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.

1. **Marina merges on GitHub (her decision, 2026-10-10).** PR #13 (step 32) first, then `step/33-*` … `step/64-*` in order: open a PR → green CI → merge (the branches are already pushed). Claude's merge chain was denied by the classifier twice; Claude can push branches and open PRs if asked.
2. **Marina: decide the M5 gate.** Evidence: `pnpm test:gate` (real API + storefront + gateway, 1803 checks) and the browser pass in docs/verification.md "Step 64". Caveat: the products are seeded, because publishing through the admin waits for BI-02.
3. **Then `/step 65` (M6 — quote and pricing).** Find the row with `rg -n "^| 65 " docs/roadmap.md` and check `docs/business-inputs.md`: BI-02 (tax) blocks 67, 70, 72; BI-03 (delivery areas/fee) blocks 66, 70.
   - Storefront pages: use `storeRead`; no `loading.tsx` under `(shop)`; never export data from a `"use client"` file to a server component; add new URLs to `scripts/check-age-preview.mjs` and, for anything touching the age boundary, `scripts/check-gate-e2e.cjs`.
   - Manual look with real data: `pnpm build && pnpm test:gate -- --serve` (prints URL, cookie, a variant ID). With stub data: `pnpm test:age-preview -- --serve`.
   - The step-60 migration creates `pg_trgm` in schema `public`: the migration role needs that right on staging/production.
   - Local storefront dev needs age keys in `.env`: run `pnpm age:keygen` and paste the three lines (Claude cannot read or edit `.env`). Without them every page redirects to the age check and accepting answers 503.
   - If `http://localhost:8080/api/age/*` answers 404, the gateway container is running an old config: `docker compose restart gateway`.
   - Every later stock writer (orders, steps 75–76, 85–86) must call `publishLowStockCrossing` in its transaction (ADR 0023).
4. **Publishing is still blocked by BI-02**, so there are no published products in a real database: storefront pages need seeded data (tests seed published rows directly; see `apps/api/src/store/store-catalog.int.test.ts`).
5. **Local invalidation call:** to exercise the worker → API call in dev, set `INTERNAL_SERVICE_KEYS` and the worker's `INTERNAL_SERVICE_*` in `.env` (see `.env.example`). Without them the effect completes as `skipped:not_configured`.
6. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README). `/tmp/ih-qa` does not survive; reinstall `playwright-core` there (or any directory) and set `QA_PLAYWRIGHT_DIR`.

BI-02 gates real publication and the M4 gate.

## Blockers

BI-01 and BI-09 (OPEN) block the contact copy and WhatsApp number/wording of step 64 (built so that links appear only once the Owner sets the number). BI-04 (OPEN) blocks the policy values and copy of steps 55–57 (55–56 built with placeholders; production refuses the `unapproved` policy); BI-05 (OPEN) blocks any product indexing or preview (step 57 built with both off). BI-02 blocks real publication and so the M4 gate. Real settings/coverage require BI-01/BI-03/BI-09 and remaining BI-07 inputs. New-password browser submission needs user handoff under Computer Use policy; real mobile interaction QA remains open. BI-11 blocks real Owner bootstrap; BI-06 blocks staging. No milestone gate changes.

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
- 55 — age ticket: Ed25519 `v1.kid.payload.signature` signer/verifier and key ring, `@AgeVerified()` API guard (403 `AGE_VERIFICATION_REQUIRED`, fail closed), private key storefront-only by schema, `pnpm age:keygen`, rotation runbook (ADR 0024; BI-04 values in config) — 0a4c250
- 56 — storefront age gate: deny-by-default `proxy.ts`, `/api/age/accept|reject` (Origin check, per-address limit, HttpOnly cookies, local-only return path), age-check and restricted pages (ADR 0025; BI-04 placeholders) — 8971a0e
- 57 — generic preview: one name/description/Open Graph image for every URL, `robots.txt` disallow-all, public `/responsible-use` `/terms` `/privacy` shells, per-request rendering, `pnpm test:age-preview` in verify (ADR 0026; BI-04/BI-05 pending) — 54b1d6d
- 58 — store catalogue API: `GET /v1/store/brands|categories|products|products/:slug` behind `@AgeVerified()`, one visibility rule, contract-only fields, fils prices, availability, signed image links, keyset cursors, cache on first pages and found products, per-address limit (ADR 0027) — 0e7700a
- 59 — listing pages: `/shop`, type pages, `/brands`, `/brands/[slug]`, `/categories/[slug]`; server-side store client forwarding only ticket + address; card, controls, cursor paging, empty/404/error states, pending indicators; stub-API rendering in `test:age-preview` (ADR 0028) — b0d8edb
- 60 — search: `product_search` projection with triggers, FTS prefix match with trigram near-miss fallback, seven filters, disjunctive facets, five sorts, keyset cursors, suggestions; `/search` page with filter form and header search (ADR 0029) — 3ea0d60
- 61 — product page `/p/[slug]`, selection rules that never substitute or preselect, variant-specific price/stock, quick add dialog, device cart store `ih_cart_v1`, legacy checkout keys removed on every page (ADR 0030) — 8438b20
- 62 — device cart UI: `GET /v1/store/cart/lines` refresh, line states that never remove or substitute, `/cart` page, header count, preview subtotal in fils (ADR 0031) — ef4fbbf
- 63 — device lists `ih_lists_v1` (saved, compare, recently viewed; slugs only), `GET /v1/store/product-cards`, heart on cards and product page, `/wishlist`, `/compare`, recently-viewed rail (ADR 0032) — 42da99d
- 64 — store shell and home shell, `GET /v1/store/info` + WhatsApp links only when configured, `pnpm test:gate` real-stack age-boundary check (ADR 0033; BI-01/BI-09 pending) — `step(64)` commit on `step/64-shell-gate-verification`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`, `email`, `media_processor`, `storefront_revalidate`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-11, step 64)

Done:

- **Step 64 (ADR 0033)**, without BI-01/BI-09:
  - API: `GET /v1/store/info` (`readStoreInfo`, WhatsApp number only).
  - Storefront: shell layout (header, footer, skip link, `NavLinks`), home page moved to `app/(shop)/page.tsx`, `lib/whatsapp.ts`, `WhatsAppLink`, links on footer/product/cart, `storeInfo` (per-request, never redirects), `/age-check?recheck=1`.
  - Verification: `scripts/check-gate-e2e.cjs` as `pnpm test:gate` (in `verify --integration`), with `--serve`.
- Found and fixed in this step: verified pages answered 500 (navigation list imported from a client file).
- **`invariant-reviewer`:** no blockers; three should-fixes done.

Files: `packages/contracts/src/store.ts`, `packages/db/src/store-catalogue.ts`, `apps/api/src/store/{store-catalog.controller,store-catalog.service,store-catalog.int.test}.ts`, `apps/storefront/{lib/whatsapp.ts,lib/whatsapp.test.ts,lib/site.ts,lib/store/api.ts,lib/store/server.ts,lib/age/policy.ts,lib/age/age-gate.test.ts,components/nav-links.tsx,components/whatsapp-link.tsx,components/cart-view.tsx,app/(shop)/layout.tsx,app/(shop)/page.tsx,app/(shop)/p/[slug]/page.tsx,app/(shop)/cart/page.tsx}`, `scripts/{check-gate-e2e.cjs,check-age-preview.mjs,verify.mjs}`, `package.json`, `CLAUDE.md` (command list), `docs/decisions/0033-store-shell-and-gate-verification.md`, `docs/{business-inputs,implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 491, integration 358, gateway 29, age-preview 1847, gate 1803). Browser pass through the real gateway: 14 checks PASS.

Unfinished:

- PR #13 and steps 33–64 are not merged (branches pushed 2026-10-11; Marina merges on GitHub).
- M5 gate awaits Marina's decision (seeded data; BI-02 blocks real publishing).
- BI-01/BI-09: contact copy, WhatsApp number and wording; BI-04: footer warning wording. No mobile menu sheet, help pages or content sections yet.
- Migrations are not applied to the dev database.

## History (summary)

- 2026-10-11 step 63: saved items, compare, recently viewed (42da99d); verify unit 486/integration 357/gateway 29/age-preview 1828.
- 2026-10-11 step 62: device cart UI and refresh route (ef4fbbf); verify unit 478/integration 356/gateway 29/age-preview 1676.
- 2026-10-11 step 61: product page, selection rules, quick add, device cart store (8438b20); verify unit 470/integration 355/gateway 29/age-preview 1600.
- 2026-10-11 steps 55–61: age ticket, gate routes, generic preview, store API, listing pages, search, product page (0a4c250 … 8438b20); details in docs/verification.md.
- 2026-10-11 steps 53–54: low-stock transitions (8adc131), acceptance pass + browser QA 32/32 (5e65bda).
- 2026-10-10 steps 46–52: stock ledger, set-stock, media upload/processing, gallery, publication, catalogue cache (0923c1f … 00e4bfc); details per step in docs/verification.md.
- 2026-10-08 … 10-10 steps 18–45: reliability foundation (audit/outbox/effects/worker/scheduler, M2 gate), email/storage/service auth, identity/sessions/RBAC/CSRF/limiters/reset/invites/staff/settings/delivery (M3 steps), catalogue schema, brands/categories/products/variants — details per step in docs/verification.md and git history.
