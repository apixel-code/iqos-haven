# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-12
- Milestone: M6 — customers, pricing, coupons and server quote: all steps (65–72) done; gate evidence ready, awaiting Marina's decision. M5: PASSED 2026-10-11. M4 steps done, gate awaits Marina's decision (publishing unblocked); M3 gate not closed; M0 review and M1 staging/fixtures still open
- Step: 72 (pricing and promotion acceptance pass) — done; next is 73 (M7)
- Branch: `step/72-pricing-acceptance` (stacked on PRs #47–#53: step 66, business-input fixes, steps 67–71; all wait for Marina's merge)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: branch each step from `main` as `step/N-short-name`. After `/verify` and the commit, push and open a PR against `main`; Marina merges it on GitHub ("Create a merge commit") because Claude's `gh pr merge` is denied by the classifier. Then fast-forward local `main`.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.
- Marina's answers (2026-10-12, ADR 0036, docs/business-inputs.md): prices are final as entered, no tax calculation (BI-02); delivery covers the seven emirates at one flat fee (BI-03); minimum age 18 as built (BI-04); Hostinger VPS (BI-06); catalogue, Owner and staff are entered through the admin (BI-10/11); retention defaults chosen by Apixel (BI-08). Still open: BI-01, BI-09 (demo values for now), BI-05 (indexing stays off).

1. **Marina merges on GitHub** ("Create a merge commit"). The open PRs are stacked, so merging only the last one (step 72) lands all of them; otherwise merge them in number order. Then `git checkout main && git pull --ff-only`.
2. **Marina: decide the M6 gate (and M4).** Evidence and caveats: docs/verification.md "Step 72".
3. **Next step: `/step 73` (M7: order, item and history schema with the display number).** Find the row with `rg -n "^| 73 " docs/roadmap.md` and read M7's Dependency and Gate lines. Step 73 also adds the `coupon_redemptions.order_id` foreign key. M7 code stays behind a flag until the checkout correctness gate (roadmap note above step 73).
4. **Rules that carry forward:**
   - Checkout input (ADR 0035): parse with `checkoutContactSchema`, `checkoutAddressSchema` and `orderLinesSchema` from `@ih/contracts`; never add a second copy of a rule or message. The route must map issues to the error envelope `fields` without echoing typed values. Pre-check the area with `readDeliverableArea`; the transaction decides again with `lockDeliverySelection`.
   - Pricing (ADR 0037): totals only through `priceOrder`/`priceOrderLines`; prices only from `readOrderPrices` (preview) or `lockOrderPrices` (order transaction, after settings/area and before coupons and variants). Never share-lock variant rows. Throw `TransactionRestartError` to restart a unit of work.
   - Accepting a total (ADR 0041): the order request carries the quote token; inside the transaction call `checkAcceptedQuote(token, CartQuoteService.keys, now, quoteFacts(await lockQuoteForOrder(...)))` and answer 409 `QUOTE_CHANGED`/`QUOTE_EXPIRED` unless it is `ACCEPTED`. The storefront keeps area, code, total and token in memory only (`lib/cart/quote.ts`, `components/cart-quote.tsx`).
   - Browser pass on the real stack: `pnpm build && node scripts/check-gate-e2e.cjs --serve` prints URL, cookie, variant, schema and coupon; the gateway origin is allowed for quote POSTs. Stop it with SIGINT and drop leftover `ih_test_*` schemas.
   - Quotes (ADR 0040): every price shown or charged comes from `previewQuote` (route) or `lockQuoteForOrder` (order transaction, after the customer lock, before variants); pass its `appliedCoupon` to `redeemCoupon`. Checkout areas come from `GET /v1/store/delivery`.
   - Coupons (ADR 0038): in an order, `lockCouponForOrder` (after `lockOrderPrices`, before variants) then `redeemCoupon` with the object it returned; quotes use `previewCoupon`. A store route answers with `CouponRejectedError.code` only, never `.reason`. Step 73 adds the `coupon_redemptions.order_id` foreign key. No other trigger may write `coupons`.
   - Customers (ADR 0034): `lockCustomerForOrder`/`saveCustomerAddress` are for the order transaction only (steps 75–76): call `saveCustomerAddress` after `lockDeliverySelection`, and that transaction must write the audit entry and events.
   - Storefront pages: use `storeRead`; no `loading.tsx` under `(shop)`; never export data from a `"use client"` file to a server component; add new URLs to `scripts/check-age-preview.mjs` and, for anything touching the age boundary, `scripts/check-gate-e2e.cjs`.
   - Manual look with real data: `pnpm build && pnpm test:gate -- --serve` (prints URL, cookie, a variant ID). With stub data: `pnpm test:age-preview -- --serve`.
   - The step-60 migration creates `pg_trgm` in schema `public`: the migration role needs that right on staging/production.
   - Local storefront dev needs age keys in `.env`: run `pnpm age:keygen` and paste the three lines (Claude cannot read or edit `.env`). Without them every page redirects to the age check and accepting answers 503.
   - If `http://localhost:8080/api/age/*` answers 404, the gateway container is running an old config: `docker compose restart gateway`.
   - Every later stock writer (orders, steps 75–76, 85–86) must call `publishLowStockCrossing` in its transaction (ADR 0023).
5. **Publishing works without a tax reference** (ADR 0036): a complete product can be published from the admin. The dev database has all migrations applied (2026-10-12) but no products yet; tests still seed their own.
6. **Local invalidation call:** to exercise the worker → API call in dev, set `INTERNAL_SERVICE_KEYS` and the worker's `INTERNAL_SERVICE_*` in `.env` (see `.env.example`). Without them the effect completes as `skipped:not_configured`.
7. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README). `/tmp/ih-qa` does not survive; reinstall `playwright-core` there (or any directory) and set `QA_PLAYWRIGHT_DIR`.

## Blockers

BI-07: a verified sending domain and sender address are still needed before real email. BI-01 and BI-09 (OPEN): contact copy and WhatsApp number/wording stay demo values. BI-05 (OPEN): indexing and previews stay off. BI-11: real Owner bootstrap needs an email at deployment. Real mobile interaction QA remains open. `scripts/browser-qa/qa.mjs` still expects the publish button to be disabled for its QA product; rerun and adjust it before relying on it.

## Gates passed

- **M2 — PASSED 2026-10-09** (closed on Marina's approval). Gate: a synthetic event is written and processed by the worker; duplicate delivery and Redis job loss are recovered; tests send no real email. Evidence: `apps/worker/src/recovery.int.test.ts` "M2 gate" (queue obliterated → reconciler re-enqueue + duplicate original job → effect completed exactly once), `effects.int.test.ts` (5 concurrent duplicates apply once), real dev orphan recovered by the built worker (step 24 notes in docs/verification.md); email only to Mailpit/stubs. CI green on `main` at a2429f7 (run 37894960188) with all steps 18–26 merged. Not part of this gate: production queue Redis failover/restore drills (M11, after BI-06).
- **M5 — PASSED 2026-10-11** (closed on Marina's decision). Gate: after age acceptance real products can be browsed, selected and added to the cart; before it no restricted product data is available. Evidence: `pnpm test:gate` (real API + storefront + gateway, 1803 checks) and the real-browser pass (14 checks) in docs/verification.md "Step 64". Accepted caveat: the products were seeded, because publishing through the admin waits for BI-02.
- M0, M1, M3, M4 and M6–M11: not passed. M6: all steps (65–72) done; gate awaits Marina's decision. M4: all steps (41–54) done; publishing is unblocked (ADR 0036), the gate awaits Marina's decision.

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
- 64 — store shell and home shell, `GET /v1/store/info` + WhatsApp links only when configured, `pnpm test:gate` real-stack age-boundary check (ADR 0033; BI-01/BI-09 pending) — 82ce9b9
- 65 — `customers` + `customer_addresses` (phone-keyed, no credentials, immutable phone and address rows, no runtime delete), `normalizePhone`, transaction-only customer primitives (ADR 0034) — 209e62f
- 72 — pricing and promotion acceptance pass: `pricing-acceptance.int.test.ts` (PRICE-01 to PRICE-05 across admin API, store API and the order quote step; PRICE-06 not applicable) — `step(72)` commit on `step/72-pricing-acceptance`
- 71 — `POST /v1/store/cart/quote` with a signed quote token and fingerprint, `checkAcceptedQuote`, `QUOTE_SIGNING_KEYS`, cart page total with explicit acceptance of a changed total (ADR 0041) — 1c8fe30
- 70 — `previewQuote`/`lockQuoteForOrder` (one assembly, flat fee, free delivery off, version references), `GET /v1/store/delivery` (ADR 0040) — 201efd7
- 69 — Owner coupon API (`/v1/admin/coupons`: list, create, versioned edit, trash, restore; audit + `coupon.updated`), `coupons.deleted_at`, Discounts admin screen (ADR 0039) — 1bdaa54
- 68 — `coupons` + `coupon_redemptions` (trigger-maintained use count, limit check, release once, no delete), eligibility rules, `previewCoupon`/`lockCouponForOrder`/`redeemCoupon`/`releaseCouponRedemption` (ADR 0038) — fdab292
- 67 — `priceOrder` (integer fils, one half-up percentage discount per order, largest-remainder line shares), `readOrderPrices`/`lockOrderPrices` with brand → category → product share locks, `TransactionRestartError` (ADR 0037) — 7538c3f
- 66 — shared checkout validators (contact, address by type, Makani, notes, merged and capped lines), UAE-mobile-only phone, `readDeliverableArea` (ADR 0035; BI-03 pending) — `step(66)` commit on `step/66-checkout-validation`

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe`, `email`, `media_processor`, `storefront_revalidate`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-12, step 72)

Done:

- **Step 72:** `apps/api/src/store/pricing-acceptance.int.test.ts` (7 tests: PRICE-01 ×2, PRICE-02, PRICE-03, PRICE-04, PRICE-05, quoting reserves nothing); `docs/acceptance.md` rows PRICE-01, PRICE-05, PRICE-06 updated for ADR 0036. No production code changed; `invariant-reviewer` not run.
- All M6 steps are done.

Files: `apps/api/src/store/pricing-acceptance.int.test.ts`, `docs/{acceptance,implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 548, integration 414, gateway 29, age-preview 1847, gate 1928).

Unfinished:

- PRs #47–#53 and the step-72 PR wait for Marina's merge. M4 and M6 gates await her decision.
- The Checkout button is still disabled: orders arrive in M7.
- The admin product and delivery screens were not opened in a browser after the ADR 0036 change; `scripts/browser-qa/qa.mjs` still expects a disabled Publish button for its QA product and has no coupon checks.
- The Owner has not entered areas, fee or ETA, so the dev storefront shows "Delivery is not available yet."

## History (summary)

- 2026-10-12 step 71: signed quote API, cart total and acceptance (1c8fe30, PR #53); verify unit 548/integration 407/gateway 29/age-preview 1847/gate 1928; browser 23 checks.
- 2026-10-12 step 70: quote assembly and store delivery route (201efd7, PR #52); verify unit 534/integration 401/gateway 29/age-preview 1847/gate 1867.
- 2026-10-12 step 69: Owner coupon administration and Discounts screen (1bdaa54, PR #51); verify unit 534/integration 394/gateway 29/age-preview 1847/gate 1803; browser 16 checks.
- 2026-10-12 step 68: percentage coupons (fdab292, PR #50); verify unit 527/integration 387/gateway 29/age-preview 1847/gate 1803.
- 2026-10-12 step 67 and business-input fixes: integer pricing (7538c3f, PR #49); final prices and UAE delivery (84f2e52, PR #48); verify unit 521/integration 376/gateway 29/age-preview 1847/gate 1803.
- 2026-10-11 step 66: checkout input validation (PR #47); verify unit 509/integration 371/gateway 29/age-preview 1847/gate 1803.
- 2026-10-11 step 65: guest customers, addresses, phone identity (209e62f, merged with PR #46); verify unit 496/integration 369/gateway 29/age-preview 1847/gate 1803.
