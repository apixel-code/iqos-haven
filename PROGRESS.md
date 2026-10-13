# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-13
- Milestone: M7 — transactional checkout and first complete order: all steps (73–82) done; gate evidence ready, awaiting Marina's decision. M6: all steps (65–72) done; gate evidence ready, awaiting Marina's decision. M5: PASSED 2026-10-11. M4 steps done, gate awaits Marina's decision (publishing unblocked); M3 gate not closed; M0 review and M1 staging/fixtures still open
- Step: 82 (checkout correctness gate) — done; next is 83 (M8)
- Branch: `step/82-checkout-gate` (stacked on steps 79–81; `main` holds everything through step 76; PRs #59/#60 open; steps 79–82 are local commits, not pushed: the push needs Marina's explicit go-ahead)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: branch each step from `main` as `step/N-short-name`. After `/verify` and the commit, push and open a PR against `main`; Marina merges it on GitHub ("Create a merge commit") because Claude's `gh pr merge` is denied by the classifier. Then fast-forward local `main`.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.
- Marina's answers (2026-10-12, ADR 0036, docs/business-inputs.md): prices are final as entered, no tax calculation (BI-02); delivery covers the seven emirates at one flat fee (BI-03); minimum age 18 as built (BI-04); Hostinger VPS (BI-06); catalogue, Owner and staff are entered through the admin (BI-10/11); retention defaults chosen by Apixel (BI-08). Still open: BI-01, BI-09 (demo values for now), BI-05 (indexing stays off).

1. **Step-79 push/PR approval:** automatic approval review rejected `git push -u origin step/79-order-confirmation` because exporting source to the external remote was not explicitly authorized. User approval for the `apixel-code/iqos-haven` GitHub destination is required; no retry/bypass. PR description prepared at `/tmp/ih-step79-pr-body.md` (temporary).
2. **Marina merges** from her terminal (`gh pr merge <number> --merge`) or on GitHub ("Create a merge commit"). PR #59 (step 77), #60 (step 78) and step 79 are stacked: merge the highest verified branch to include its dependencies. Then `git checkout main && git pull --ff-only`, and check that the CI run on `main` finished (a cancelled run is rerun with `gh run rerun <id>`).
3. **Marina: decide the M6 gate (and M4).** Evidence and caveats: docs/verification.md "Step 72".
4. **Marina: decide the M7 gate.** Evidence, item by item, and what is not covered: docs/verification.md "Step 82". Checkout stays switched off (`CHECKOUT_SUBMISSION_ENABLED=false`) whatever the decision, until deployment inputs exist (BI-07 sender domain, real Owner, delivery areas and fee).
5. **Next step: `/step 83`** (first step of M8, order operations). Find the row with `rg -n "^| 83 " docs/roadmap.md` and the M8 dependency line.
6. **Rules that carry forward:**
   - Confirmation page (ADR 0050): `/order-confirmation` reads the order in the browser with the cookie; nothing from the URL, nothing stored on the device, no third-party script; only contract fields are shown and amounts are the API's. After a 201: end key, empty cart, remember the acknowledgement in memory, `router.replace`.
   - Checkout form (ADR 0049): typed details live in React state only; the device keeps `ih_checkout_attempt_v1` = `{key, createdAt}` (local storage, else session storage) and nothing else. The key ends only on an acknowledged 201 or on "Place a second order"; every other answer keeps it (`orderOutcome` in `lib/checkout/order.ts`). `GET /v1/store/info` carries `checkoutOpen`; the storefront has no switch of its own. Browser pass: `scripts/browser-qa/checkout.mjs` with `node scripts/check-gate-e2e.cjs --serve --checkout-open`.
   - Confirmation (ADR 0048): API-only `ORDER_CONFIRMATION_KEYS`; AES-GCM bound to the scoped attempt hash. SQL copies expiry (do not round-trip through JS Date); normalize BYTEA before decryption. `__Host-ih_order` grants only 30-minute private confirmation; same success replays without cookie after expiry/key retirement, never another order. `confirmation.cleanup` clears ciphertext every minute in bounded batches. GET accepts no query fields; UI must be no-store/no-referrer and excluded from analytics/session replay.
   - Notifications (ADR 0047): `order.created` requires the `notification` and `email` consumers. Inbox rows are written only by `writeNewOrderNotification` inside the effect's transaction; content is immutable and `read_at` is set once (the runtime role may update that column only). Notification and email text never hold a customer's name, phone or address. A new notification type adds its consumer to the event with a backfill decision. Step 91's inbox API must re-check the permission behind each notification type. A test that needs an event with no consumers uses `order.updated`.
   - Order route (ADR 0046): `POST /v1/store/orders` (`StoreOrdersController`), body `storeOrderRequestSchema`, `Idempotency-Key` header, answer `storeOrderResponseSchema`. Off unless `CHECKOUT_SUBMISSION_ENABLED=true` (503). Step 79 sets the confirmation cookie separately from this sanitized answer; step 80's form must keep the same key on 429, 503, `IDEMPOTENCY_IN_PROGRESS` and network errors, and treat `CHECKOUT_RECOVERY_REQUIRED` as "already placed". A new store route that takes a coupon code must call `assertOpen`/`record` with `couponFailurePolicy`. A new `RateLimiter` implementation needs `peek`.
   - Checkout input (ADR 0035): parse with `checkoutContactSchema`, `checkoutAddressSchema` and `orderLinesSchema` from `@ih/contracts`; never add a second copy of a rule or message. The route must map issues to the error envelope `fields` without echoing typed values. Pre-check the area with `readDeliverableArea`; the transaction decides again with `lockDeliverySelection`.
   - Pricing (ADR 0037): totals only through `priceOrder`/`priceOrderLines`; prices only from `readOrderPrices` (preview) or `lockOrderPrices` (order transaction, after settings/area and before coupons and variants). Never share-lock variant rows. Throw `TransactionRestartError` to restart a unit of work.
   - Order creation (ADR 0045): `CreateOrderService.place` → `createStoreOrder`, one transaction. A new stock writer adds its own ledger reason and calls `publishLowStockCrossing`. The answer stored for replay is order number, total and time only.
   - Docker Desktop stopped twice on 2026-10-13 with about 5.5 GB of disk free; `open -a Docker` and `pnpm infra:up` bring it back. A test run that reports `ECONNREFUSED …:5432` means Docker is down, not that a test failed.
   - Lock order (ADR 0044): idempotency → order → customer → delivery → catalogue → coupon → variants. Every lock primitive calls `enterLockGroup` first; a wrong sequence throws `LockOrderError`. Save an address after `lockDeliverySelection`; release a coupon after `lockOrder`; lock variants only through `lockVariantsForStock`. A new primitive that skips `enterLockGroup` is invisible to the check.
   - Integration suites occasionally fail one API test on a database connection timeout when all packages run in parallel (seen in steps 65 and 75; passes on rerun). If it repeats, lower the parallelism of `test:int` rather than ignoring it.
   - Idempotency (ADR 0043): an at-most-once command runs inside `runIdempotent` (or claims with `claimIdempotency` as its first statement) with `canonicalPayloadHash` of the normalized request. Order creation (step 76) must, right after the claim, look up `orders (creation_scope, creation_key_hash)` with the same `idempotencyKeyHash` and scope and throw `IdempotencyExpiredError` if an order exists, and store `canonicalPayloadHash` as `creation_payload_hash`. Stored answers hold no phone, name, address, token or capability. The worker's hourly `idempotency.cleanup` job removes expired answers.
   - Orders (ADR 0042): a command that changes an order writes the history row (with its command ID) and sets `version = version + 1` in the same transaction, or the commit fails; contents change only while pending/confirmed; recorded cash, delivery and cancellation fields are written once. Store only hashes of the idempotency key and confirmation capability. Tests that need an order use `seedOrder` from `@ih/db/testing`. Step 76 adds order reasons/references to `stock_movements`.
   - Deferred by Marina's decision (2026-10-12): the review nits of steps 71 and 73 (subtotal label, cap alignment, `search_path` on the order triggers) stay as they are. Whether an order edit may remove a line is decided in step 85.
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
7. **Publishing works without a tax reference** (ADR 0036): a complete product can be published from the admin. The dev database has all migrations applied (2026-10-12) but no products yet; tests still seed their own.
8. **Local invalidation call:** to exercise the worker → API call in dev, set `INTERNAL_SERVICE_KEYS` and the worker's `INTERNAL_SERVICE_*` in `.env` (see `.env.example`). Without them the effect completes as `skipped:not_configured`.
9. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README). `/tmp/ih-qa` does not survive; reinstall `playwright-core` there (or any directory) and set `QA_PLAYWRIGHT_DIR`.

## Blockers

BI-07: a verified sending domain and sender address are still needed before real email (the new-order email of step 78 is built and stays unsent until then). BI-01 and BI-09 (OPEN): contact copy and WhatsApp number/wording stay demo values. BI-05 (OPEN): indexing and previews stay off. BI-11: real Owner bootstrap needs an email at deployment. Real mobile interaction QA remains open. `scripts/browser-qa/qa.mjs` still expects the publish button to be disabled for its QA product; rerun and adjust it before relying on it.

## Gates passed

- **M2 — PASSED 2026-10-09** (closed on Marina's approval). Gate: a synthetic event is written and processed by the worker; duplicate delivery and Redis job loss are recovered; tests send no real email. Evidence: `apps/worker/src/recovery.int.test.ts` "M2 gate" (queue obliterated → reconciler re-enqueue + duplicate original job → effect completed exactly once), `effects.int.test.ts` (5 concurrent duplicates apply once), real dev orphan recovered by the built worker (step 24 notes in docs/verification.md); email only to Mailpit/stubs. CI green on `main` at a2429f7 (run 37894960188) with all steps 18–26 merged. Not part of this gate: production queue Redis failover/restore drills (M11, after BI-06).
- **M5 — PASSED 2026-10-11** (closed on Marina's decision). Gate: after age acceptance real products can be browsed, selected and added to the cart; before it no restricted product data is available. Evidence: `pnpm test:gate` (real API + storefront + gateway, 1803 checks) and the real-browser pass (14 checks) in docs/verification.md "Step 64". Accepted caveat: the products were seeded, because publishing through the admin waits for BI-02.
- M0, M1, M3, M4 and M6–M11: not passed. M7: all steps (73–82) done; gate awaits Marina's decision. M6: all steps (65–72) done; gate awaits Marina's decision. M4: all steps (41–54) done; publishing is unblocked (ADR 0036), the gate awaits Marina's decision.

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
- 82 — checkout correctness gate: worker gate test (order transaction → relay → queue → inbox and Mailpit, queue outage, cleanup jobs), HTTP gate cases (repeated lines, last unit, code burst), full browser journey with the worker's consumers running — `step(82)` commit on `step/82-checkout-gate`
- 81 — `/order-confirmation` page (cookie-read snapshot, expired and failed states, WhatsApp order message), checkout success navigates there after ending the key and emptying the cart (ADR 0050) — b04d2a9
- 80 — `/checkout` form (memory-only details, required 18+ tick, server total), durable attempt key, one outcome per API answer, cart emptied only after acknowledgement, `checkoutOpen` in store info (ADR 0049) — 678cf64
- 79 — cookie-only private confirmation API, 30-minute hashed capabilities, separately encrypted/non-extending replay and bounded ciphertext cleanup (ADR 0048) — commit `step(79): private order confirmation and encrypted replay`
- 78 — `notifications` + `notification_receipts`, `order.created` → inbox notification with per-user receipts and the `order.new` email to the Settings recipients, no customer data in either (ADR 0047) — f4da894
- 77 — `POST /v1/store/orders` behind the age ticket, store Origin and `CHECKOUT_SUBMISSION_ENABLED`; attempt limits per address and phone, refused-coupon limit across quote and order routes (limiter `peek`), stable error codes, bounded limiter-outage fallback, hourly `idempotency.cleanup` (ADR 0046) — c0af04e
- 76 — `createStoreOrder` / `CreateOrderService`: claim, locks, accepted-quote check, `SALE` ledger movements, order with snapshots, lines and history, coupon use, address, audit and `order.created` in one transaction; `stock_movements.order_id` (ADR 0045) — 116c94a
- 75 — seven lock groups with a run-time order check in every commerce lock primitive, `lockOrder`, `lockVariantsForStock`, `lockForOrderCreation` (ADR 0044) — 2c5aa72
- 74 — `idempotency_records` and the claim/replay functions: replay, conflict, bounded in-progress wait, clean rollback, never new after expiry (ADR 0043) — 2c55878
- 73 — `orders`, `order_items`, `order_status_history` (snapshots, six-state machine and money consistency enforced in the database, display number `IH-001001`, coupon redemption foreign key), `seedOrder` fixture (ADR 0042) — f86a7ba
- 72 — pricing and promotion acceptance pass: `pricing-acceptance.int.test.ts` (PRICE-01 to PRICE-05 across admin API, store API and the order quote step; PRICE-06 not applicable) — 56f0099
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

## Last session handoff (2026-10-13, step 82)

Done:

- **Step 82:** `apps/worker/src/checkout-gate.int.test.ts` (3 tests); four "gate:" tests in `store-orders.int.test.ts`; `scripts/browser-qa/checkout.mjs` now runs the whole journey (49 checks) and `check-gate-e2e.cjs --serve` runs the worker's relay, queue and consumers on its schema; one misleading hint fixed in `checkout-view.tsx`.
- **`invariant-reviewer`** judged the evidence: every gate item has a strong test; done: duplicate deliveries are now waited for, the "no queue" API test is named for what it shows, the outage test checks both effects stay untouched, the browser journey joins HTTP orders to the worker.

Files: `apps/worker/src/checkout-gate.int.test.ts`, `apps/api/src/orders/store-orders.int.test.ts`, `apps/storefront/components/checkout-view.tsx`, `scripts/{check-gate-e2e.cjs,browser-qa/checkout.mjs,browser-qa/README.md}`, `docs/{verification,task-backlog,implementation-status}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 577, integration 489, gateway 29, age-preview 2008, gate 2175). Browser journey 49/49 on the final code.

Unfinished:

- M7 gate decision is Marina's. Steps 79–82 are local commits; nothing was pushed. PRs #59/#60 wait for her merge; M4 and M6 gates await her decision.
- Not covered (also in docs/verification.md): the browser journey is a local script, not part of `pnpm verify` or CI; the age answer in it is posted, not clicked; email in the browser run goes to a stub adapter (Mailpit delivery is in the worker test); real mobile devices; a last-coupon race over HTTP (service level only); log capture for PII on the checkout path.
- Two `ih_test_*` schemas of unknown origin are in the test database (`…170e73fb…`, `…9acfd98f…`); left alone.

## History (summary)

- 2026-10-13 step 81: confirmation page, ADR 0050 (b04d2a9, not pushed); verify unit 577/integration 482/gateway 29/age-preview 2008/gate 2175; browser 28 checks.
- 2026-10-13 step 80: checkout form and attempt key, ADR 0049 (678cf64, not pushed); verify unit 573/integration 482/gateway 29/age-preview 1855/gate 2079; browser 21 checks.
- 2026-10-13 step 79: cookie-only confirmation API and encrypted replay, ADR 0048 (dd7dc27, not pushed); verify unit 562/integration 482/gateway 29/age-preview 1847/gate 1978.
- 2026-10-13 step 78: immutable inbox/receipts and new-order email consumers, ADR 0047 (f4da894, PR #60); verify unit 554/integration 476/gateway 29/age-preview 1847/gate 1978. Provider email/queued worker journey and inbox UI remain open; checkout off.
- 2026-10-13 step 77: store order route, limits and outage fallback (c0af04e, PR #59); verify unit 554/integration 469/gateway 29/age-preview 1847/gate 1978.
- 2026-10-13 step 76: atomic order creation (116c94a, PR #58, merged); verify unit 550/integration 458/gateway 29/age-preview 1847/gate 1928.
- 2026-10-12 step 75: canonical lock order (2c5aa72, PR #57); verify unit 550/integration 445/gateway 29/age-preview 1847/gate 1928.
- 2026-10-12 step 74: idempotent commands (2c55878, PR #56, merged); verify unit 550/integration 439/gateway 29/age-preview 1847/gate 1928.
