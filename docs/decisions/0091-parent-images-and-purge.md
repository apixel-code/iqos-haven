# 0091 — Brand logos, category images, and the Owner's purge of brands and categories

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A7 (follows ADRs 0018–0021, 0027 and 0065)

## Context

Brands had a `logo_key` and categories an `image_key` column from step 41, but nothing could fill them: the admin form said "later", and the store never showed either. A trashed brand or category could only be restored, never deleted. Marina chose G-A7 for launch (2026-10-17).

## Decision

**Images.**

- **A third media purpose, `catalogue`:** brand logos and category images, with no product. They use the same quarantine, upload policy, worker processing and derivatives as product and content images, and the same open-upload limit.
- **Who can upload:** staff who edit the catalogue (`catalog.write` and `media.upload`), which is why `content` was not reused (that needs `content.manage`).
- **Routes:** `POST /v1/admin/catalogue-images/uploads`, `POST /v1/admin/catalogue-images/:id/complete` and `GET /v1/admin/catalogue-images/:id` (state and a five-minute preview link).
- **References:**
  - The unused free-text columns are replaced by `brands.logo_asset_id` and `categories.image_asset_id` (foreign keys, `RESTRICT`). The migration refuses to run if either old column holds a value.
  - A trigger accepts only a **ready catalogue** image (`IH005`, answered as 409 `MEDIA_NOT_READY`), and another keeps an image in use ready.
  - The brand and category commands take `logoAssetId` / `imageAssetId`: omitted means unchanged, null clears it.
  - A replaced or cleared image that nothing else uses is released (`removed`); hourly cleanup then deletes its private original, as for gallery images.
- **Store:** `GET /v1/store/brands` and `/categories` carry the signed image (`logo` / `image`, alt text = the name). The cached answer is dropped on any catalogue change. The storefront shows the logo on the brands index and the brand page, and the image on the category page.
- **Admin:** a Logo / Image field in the create and edit forms: upload, wait for processing, preview, replace, remove.

**Purge.**

- `POST /v1/admin/brands/:id/purge` and `/categories/:id/purge` (`catalog.purge`, the Owner) delete a **trashed** brand or category, at its version.
- **Refused:**
  - while any product uses it, trashed products included (409 `IN_USE`); order lines keep their own name snapshots, and products cannot exist without a brand and category;
  - when it is not trashed (409 `NOT_TRASHED`).
- **What goes with it:** its slug redirects, and its image is released. A `SECURITY DEFINER` function is the only delete path, as for product purge. The purge is audited and publishes `catalog.changed`.
- **Admin:** "Delete permanently" in Trash, after a confirmation, for the Owner only.

## Consequences

- Brands and categories can carry an image end to end, from upload to the store, without any free-text storage keys.
- Purged brands and categories leave no redirects, and their old links then answer 404.
- Derivatives of released images stay in the private media bucket, as gallery ones do; a bucket lifecycle rule can remove them later.
