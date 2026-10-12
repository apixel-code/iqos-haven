# 0021 — Product publication, trash/restore and reference-aware purge

- Date: 2026-10-10
- Status: accepted; the tax-treatment publish requirement is superseded by ADR 0036 (prices are final, no tax reference)
- Step(s): 51 (extended by orders 73+, storefront 56–60, BI-02)

## Context

Roadmap step 51 lets Staff publish, trash and restore products where they are permitted, and makes purge Owner-only. History must never be cascade-deleted. Further rules come from three places:

- **Architecture §5:** products are soft-deleted, and hard purge is blocked by historical foreign keys.
- **Prototype:** a product needs an image and a description before publishing.
- **Root invariants:** zero stock does not unpublish.

BI-02 (approved VAT/excise treatment) is still open. Step 41 makes publication require a tax reference, and step 44 keeps that reference read-only.

## Decision

**Readiness.** `GET /v1/admin/products/:id/readiness` lists what is missing before publishing. The same server check guards every publish:

- `tax_treatment`;
- `active_variant` and `default_variant` (the default must be active);
- `image` (a primary gallery image);
- `description` (at least 20 characters);
- `price`: the base price is above 0, and no active variant overrides it to 0;
- `puff_count` (disposables only);
- `live_brand_category`;
- `not_trashed`.

Stock is not a requirement.

Until BI-02 provides approved treatments, every product reports `tax_treatment` and publishing returns `PUBLISH_REQUIREMENTS`. This is deliberate: it fails closed. Everything else is built and tested with a synthetic approved reference.

**Commands.** All commands take the expected version.

- Publish and move to draft need `catalog.publish`.
- Trash and restore need `catalog.trash`.
- Purge needs `catalog.purge`, which is Owner-only.

Every command runs in one transaction with this lock order: actor `FOR SHARE`, brand then category `FOR SHARE`, then the product `FOR UPDATE`. Audit and a `catalog.changed` event are written in the same transaction.

- **Trash** takes a published product off the store immediately: it becomes a draft and is trashed in the same update.
- **Restore** returns the product as a draft.
- **Repeat publish or unpublish** is a no-op. The expected version is still checked first, so a stale repeat conflicts.
- **Parent lock check:** the parent ids are re-read under the product lock. If a concurrent edit moved the product to another brand or category, the command conflicts instead of holding the wrong parents.
- **Errors:** a trashed product returns `TRASHED`, restoring a live one returns `NOT_TRASHED`, and a stale version returns `VERSION_CONFLICT`.

**Published products stay publishable.** These writes run `assertStillPublishable` after their change and under the product lock:

- product edits;
- variant edits;
- option edits;
- gallery removal.

If the published product would no longer meet the requirements, the whole change rolls back with `PUBLISH_REQUIREMENTS`. Examples: removing the last image, losing the last active variant, or shortening the description below 20 characters. To make such changes, move the product to draft first. A test found the gap: publishing and then removing the last image used to leave a published product with no image.

**Purge.** `POST /v1/admin/products/:id/purge` works only for trashed products. The runtime role has no DELETE on catalogue or media rows, so purge goes through `catalogue_purge_product(uuid)`:

- It is a SECURITY DEFINER function.
- Its `search_path` is pinned to its own schema plus `pg_temp`, so callers cannot shadow tables.
- EXECUTE is granted to `ih_app` only.

The function is callable by any `ih_app` SQL path, without the API's actor check or audit. This is accepted because `ih_app` is the API's own role and the function refuses non-trashed products and products with history.

The function locks the product. It refuses unless the product is trashed (`IH003`, `NOT_TRASHED`) and has no stock history (`IH004`, `IN_USE`). Once orders exist, order lines will also block purge through their RESTRICT foreign keys.

It deletes the product's images, media assets, options, variants, redirects and the product row, and returns the private storage keys: the derivatives plus any originals not yet deleted. The API deletes those objects after commit. A failed delete leaves only an unreachable private object, which is logged and reported as `failedDeletes`.

Media that finishes processing while the purge runs can also write objects after the keys were collected; the processor's state update then finds no row and records nothing. A bucket lifecycle rule (BI-06) on both buckets is the backstop for such orphans. The audit and outbox rows keep the history by ID.

**Admin UI.**

- The product editor has a Publishing card: a requirement checklist in plain language (including the accountant decision), Publish, Move to draft, and Move to trash. Controls appear only when the caller has the permission.
- The product list has a Trash tab:
  - "Restore as draft";
  - for the Owner, "Delete permanently". It is enabled only after ticking "I understand this cannot be undone", and asks for confirmation.

## Alternatives considered

- **A writable tax reference "to unblock testing":** this would let anyone declare a tax treatment approved. BI-02 belongs to the accountant.
- **Granting DELETE to the runtime role for purge:** every SQL path in the API could then delete catalogue history. A single audited function, with its checks, is narrower.
- **Unpublishing automatically when an edit breaks readiness:** a silent unpublish of a live product is surprising. Refusing the edit makes the consequence explicit.

## Consequences

- When BI-02 is answered, step 67 adds approved treatments and a way to assign them; publishing then works without any code change here.
- Order steps must keep their RESTRICT foreign keys to products and variants, so purge stays reference-aware.
- The storefront (56–60) shows only published, live products, with no age-gate bypass.
