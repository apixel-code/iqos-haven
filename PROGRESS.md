# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-10
- Milestone: M4 — catalogue, variants, safe media and inventory (started; M3 gate not closed; M0 review and M1 staging/fixtures still open)
- Step: 51 (publication, trash/restore, purge) — done; browser QA PASS for steps 42–51 admin screens
- Branch: `step/51-publication` (stacked on local step 50 `a22ae8a`; merge dependency PRs in step order)
- See docs/verification.md for actual checks.

## Next action

**Start of a new session:**

- Git: you are on `step/51-publication`, which is clean. Steps 33–51 are local, stacked commits; only `main` (through step 31) is on GitHub.
- New work: branch the next step from `step/51-publication` (for example `git checkout -b step/52-...`). Do not branch from `main` until the chain is merged.
- Toolchain: prefix commands with `export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`. If Docker is down, run `open -a Docker` and then `pnpm infra:up`.

1. **Marina: merge.** Merge PR #13 (step 32, CI green), then for `step/33-*` … `step/51-*`, in order: push → open a PR → wait for green CI → merge.
   - Marina asked Claude to merge (2026-10-10), but the auto-mode classifier denied the merge chain twice.
   - Two ways forward:
     - Marina merges on GitHub.
     - Marina adds a Claude Code permission rule allowing `git push` and `gh pr merge` for this repo, and Claude runs the chain sequentially: push → `gh pr create --base main` → `gh pr checks --watch` → `gh pr merge --merge`, stopping at the first red CI.
2. **Then `/step 52`: catalogue cache and internal invalidation.** Find the row with `rg -n "^| 52 " docs/roadmap.md`.
   - The `catalog.changed` → `storefront_revalidate` consumer needs a backfill decision (architecture §8).
   - Use the internal HMAC route (step 26).
3. **Browser QA for later admin steps:** use `scripts/browser-qa/` (README). It runs on an isolated test schema through the real gateway.

BI-02 gates real publication and the M4 gate.

## Blockers

None for step 41 schema work. Real settings/coverage require BI-01/BI-03/BI-09 and remaining BI-07 inputs. New-password browser submission needs user handoff under Computer Use policy; real mobile interaction QA remains open. BI-11 blocks real Owner bootstrap; BI-06 blocks staging. No milestone gate changes.

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

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- Event `consumers` lists only implemented consumers (now `system_probe` and `email`); planned ones are documented with roadmap steps and move in with a backfill decision (architecture §8: adding a consumer must not redefine old completions).
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-10, step 51)

Done:

- **Browser QA for steps 42–50:** first pass 19/19 with a fix, then 27/27 including step 51. The QA found a real bug: the "Add product" editor looped forever. Fixed in `a22ae8a`.
- **Step 51 (ADR 0021):**
  - Migration `20261010001100_product_purge`: the `catalogue_purge_product` SECURITY DEFINER function with a pinned search_path.
  - `packages/db/src/publication.ts`: readiness, state changes with the parent lock re-checked, purge, and `assertStillPublishable`. The last is wired into product, variant/option and gallery writes.
  - API: publication controller/service, including storage deletes after commit.
  - Admin: Publishing card, Trash tab with restore and a confirmed purge.
  - Contracts: readiness/purge schemas and `NOT_TRASHED`.
- **`invariant-reviewer`:** no blockers. Should-fixes are done: parent-lock recheck, zero-price variant, orphan backstop documented, purge schema. Test gaps are covered.
- **Merge:** attempted again on Marina's request. The classifier denied it, so nothing was pushed.

Files: `packages/db/prisma/migrations/20261010001100_product_purge/`, `packages/db/src/{publication,products,variants,gallery,index}.ts`, `packages/contracts/src/{products,index}.ts`, `apps/api/src/catalogue/{publication.controller,publication.service,publication.int.test,products.int.test,catalogue.module}.ts`, `apps/admin/{components/product-publishing.tsx,components/product-management.tsx,lib/publication.ts,lib/publication.test.ts,lib/management.ts,lib/catalogue.test.ts}`, `docs/decisions/0021-publication-trash-purge.md`, `docs/{implementation-status,task-backlog,verification}.md`, `PROGRESS.md`.

Tests: `pnpm verify -- --integration` PASS (unit 346, integration 305, gateway 29). Browser QA 27/27 PASS.

Unfinished:

- PR #13 and steps 33–51 are not merged.
- BI-02 still blocks real publishing.
- Migrations are not applied to the dev database.
- Real mobile touch/keyboard QA and reset/invite submission have not been done.

## History (summary)

- 2026-10-10 step 50: product gallery (4bdbeed) + browser QA fix (a22ae8a); verify unit 345/integration 293/gateway 29.
- 2026-10-10 step 49: media validation, Sharp derivatives, quarantine cleanup (3e9b5f7); verify unit 342/integration 286/gateway 29.
- 2026-10-10 step 48: quarantine media upload authorization (16d3867); verify unit 334/integration 280/gateway 29.
- 2026-10-10 step 47: set-stock + admin Stock workspace (947f097); verify unit 333/integration 272/gateway 29.
- 2026-10-10 step 46: append-only stock ledger + inventory API (0923c1f); verify unit 331/integration 266/gateway 29.
- 2026-10-08 … 10-10 steps 18–45: reliability foundation (audit/outbox/effects/worker/scheduler, M2 gate), email/storage/service auth, identity/sessions/RBAC/CSRF/limiters/reset/invites/staff/settings/delivery (M3 steps), catalogue schema, brands/categories/products/variants — details per step in docs/verification.md and git history.
