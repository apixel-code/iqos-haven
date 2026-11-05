# 0107 — Flavour pictures

- Status: Accepted
- Date: 2026-11-05
- Decided by: Marina

## Context

Each TEREA product is one regional edition, such as Kyrgyzstan or Japan, and its flavours are variants. The client supplied one pack picture per flavour. On 2026-11-05 they were put into each product's gallery, as Marina chose as a first step. That approach has two limits:

- Choosing a flavour on the product page did not show its pack. The shopper had to find the right picture in the gallery.
- A gallery holds at most eight pictures. Indonesia has 10 flavours and Kazakhstan has 9, so some packs could not be shown.

## Decision

- **Database:** `product_images.variant_id` is nullable. A picture may show one variant of its own product. This is enforced by a composite foreign key to `variants (product_id, id)`, which needs a new unique index. A partial unique index allows at most one picture per variant. When a variant row is deleted (product purge only), its pictures stay as general pictures (`ON DELETE SET NULL (variant_id)`). The migration is expand-only.
- **Limit:** `MAX_PRODUCT_IMAGES` rises from 8 to 24: one picture per flavour plus a few general photos. The limit is still enforced in the application under the product row lock, as before.
- **Admin API:** `PATCH /v1/admin/products/:id/images/:imageId` takes an optional `variantId`.
  - Left out, the link is unchanged, so an older admin client keeps working.
  - Null clears the link.
  - Choosing a flavour that another picture already shows moves the link to this picture, in the same transaction.
  - A variant of another product, or an unknown one, is `409 VARIANT_MISMATCH`.
  - The audit records `variantChanged` and the new `variantId`.
- **Admin UI:** a tile shows its flavour. The image dialog, now "Image details", has a "Flavour shown" select next to the alt text.
- **Store API:** product images carry `variantId`, but only while that variant is active.
- **Storefront:**
  - **Product page:** the buy box announces the chosen variant with a window event. The gallery scrolls to that variant's picture, if it has one.
  - **Toast:** the added-to-cart toast shows the flavour's own thumbnail.
  - **Cards:** listing cards and cart lines still use the product's primary picture.

## Consequences

- The client's flavour pictures already in the galleries are linked to their flavours by an audited admin-API run after the deploy. That run also adds the packs that the old limit left out.
- A product page can now carry up to 24 signed image links. That is still small next to the page's other data.
- The admin dashboard integration test places an order "three hours ago". Between 00:00 and 03:00 Dubai time that order falls on the previous day, so two dashboard tests fail during that window. This is not related to this change: the same failure occurs on `main`.
