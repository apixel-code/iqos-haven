# 0020 — Product gallery: ready assets only, product-locked rules, private signed previews

- Date: 2026-10-10
- Status: accepted
- Step(s): 50 (storefront serving 56–60; publish rules 51)

## Context

Roadmap step 50 asks for:

- a product image gallery with a primary image, sort order and alt text;
- an upload processing state and recovery from failures;
- only sanitized derivatives made public.

Architecture §5 sets at most eight published images and one primary, enforced as cross-row rules under a parent lock. The root `CLAUDE.md` adds two constraints. Product data includes images, and an unverified visitor gets zero product data. So derivatives cannot sit on an open CDN without the age gate.

## Decision

**Data.** Migration `20261010001000_product_gallery`:

- `product_images.media_asset_id` is NOT NULL, UNIQUE and RESTRICT.
- A trigger allows only a `ready` media asset of the same product. It reads the asset `FOR SHARE`.
- A second trigger keeps an attached asset `ready` and on its product. Removal deletes the gallery row first, then marks the asset `removed`.
- Attaching requires all three derivatives (large, medium and thumb).
- `product_images` had no rows before this step, so the NOT NULL column is safe to add.
- `asset_key` holds the asset's large WebP derivative key, and `mime` is `image/webp`.
- `media_assets` gains the state `removed`.

**API.** All routes are under `/v1/admin/products/:id/images`. Reading needs `catalog.read`; changes need `catalog.write`. Every response is the full snapshot: images plus the uploads not yet in the gallery, newest first, with their state and error codes so the editor can recover from failures.

- `GET`: returns the snapshot.
- `POST`: attaches a ready asset. Attaching the same asset again changes nothing. A non-ready asset gets `MEDIA_NOT_READY`, and an asset from another product gets 404.
- `PATCH :imageId`: changes the alt text, or moves the primary here. The primary cannot be unset (`DEFAULT_REQUIRED`). The expected version is required.
- `PUT order`: takes every current image exactly once; otherwise `ORDER_MISMATCH`.
- `POST :imageId/remove`: removes the image, promotes the next one to primary, keeps the order dense, and marks the asset `removed`, which frees its upload slot.

**Locking.** Each mutation locks the actor, then the product `FOR UPDATE`, then the asset. This serializes the eight-image limit (`IMAGE_LIMIT`), the single primary and the dense order. Audit (`catalog.image_*`) and a product-level `catalog.changed` event are written in the same transaction.

**Serving.** No bucket is public.

- The admin gets previews of the sanitized WebP derivatives (large, medium, thumb) through 10-minute signed links. These are signed locally after the database work. The original is never linked.
- The storefront will serve images only through the age-gated catalogue surface (steps 56–60), for example as short signed links or an age-checked proxy, never through an open CDN. Its own ADR records that choice when it is built.

**Admin UI.** The product editor's Images card:

- uploads the file straight to quarantine;
- polls while processing, offers "Add to gallery" for ready uploads and explains rejections;
- edits alt text, sets the primary, moves images up or down, and removes them after confirmation.

Browser uploads need CORS on the quarantine bucket for the admin origin (BI-06). Local MinIO allows them.

## Alternatives considered

- A public CDN for derivatives would break the age-gate invariant, because product images are product data.
- Attaching automatically in the worker would make the worker write gallery rows under the product lock, mixing the processing and curation steps. An explicit attach keeps curation with staff, and the UI makes it one click.
- Hard-deleting the media asset when an image is removed would lose history. The derivatives and the row stay; purge belongs to step 51.

## Consequences

- Step 51 publishing must require at least one gallery image (prototype: "Add at least one image before publishing").
- Step 51 purge decides when removed assets' derivatives are deleted.
- Storefront image delivery is designed with the age gate in steps 56–60.
