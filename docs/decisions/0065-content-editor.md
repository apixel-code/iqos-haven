# 0065 — Content editor: draft, preview, publish and content images

- Date: 2026-10-15
- Status: accepted
- Step(s): 97 (storage: ADR 0064; public read: 98)

## Context

Roadmap step 97 has this done condition: versioned drafts, a safe preview, Owner only, and no arbitrary HTML or page builder.

The admin prototype (`VIEWS.content`) has one "Save & publish" button, an approximate live preview, and images inlined as base64 data URLs with no alt text.

## Decision

**Routes.** All routes are `/v1/admin/content` and need `content.manage`, which only the Owner holds. Writes are limited per actor and address.

| Route                                               | What it does                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                             | All seven sections in order. A section never saved has version 0 and no draft.                                                                                                                                                        |
| `PUT /:key/draft`                                   | Takes `{ expectedVersion, content }`. The content is parsed with the section's schema, and an invalid document is a 400 whose `fields` are `content.<path>`.                                                                          |
| `POST /:key/publish`                                | Takes `{ expectedVersion }`.                                                                                                                                                                                                          |
| `GET /:key/preview`                                 | The saved draft's references, resolved: products (name, visibility, sold out, price from), brands, categories, and images as short-lived signed links to a sanitized derivative. Also lists the problems that would block publishing. |
| `GET /images`                                       | The newest content images, with signed previews.                                                                                                                                                                                      |
| `POST /images/uploads`, `POST /images/:id/complete` | Upload a content image.                                                                                                                                                                                                               |

`PUT /:key/draft` and `POST /:key/publish` can refuse with these 409 codes:

- `VERSION_CONFLICT`: the version is not the one the editor loaded.
- `NOTHING_TO_PUBLISH`: the draft is what is already published.
- `CONTENT_REFERENCES`: something in the draft cannot be shown. Its `fields` are `<kind>:<id>` with reason `missing`, `not_visible` or `not_ready`. The error filter allows exactly that shape and nothing else.

**Save, then publish.** The prototype's single "Save & publish" is split into two steps. Saving a draft changes nothing on the store; publishing does. The preview shows the saved draft, not unsaved typing, so it is exactly what Publish would put live.

**Preview safety.**

- The preview is rendered by the admin from typed fields as plain React text; nothing is ever rendered as HTML.
- Images are sanitized derivatives, behind short-lived signed links that next/image never fetches.
- The preview is never public and never cached.

**Content images.** These reuse the product upload pipeline with `purpose = 'content'` and no product: the private quarantine, the POST policy, the HEAD check before completion, `media.uploaded`, worker processing and derivatives (written under `content/<id>/`).

- At most 10 content uploads may be open at once. An advisory lock serializes that count.
- The product media routes cannot complete or read a content asset.
- `mediaAssetSchema.productId` is now nullable.

**Cache.** `content.published` now has the `storefront_revalidate` consumer, which uses the same signed invalidation as `catalog.changed`. The controller also drops the local cache after each write. No backfill is needed: nothing could be published before these routes existed.

**Editor (admin "Storefront content", under Management).**

- Tabs for the seven sections, with an unsaved marker.
- Typed fields only: the ticker messages (2–6), the hero fields, a button whose link is a select (all products, a category, a brand, or a product found by search), and an image chosen or uploaded with a required description.
- Product lists come from a search of published products, with reordering. Brands come from the active list. Best sellers is automatic or manual. There are up to two banners, and the offers products. Status shows "Not set up", "Draft, never published", "Draft differs from live", "Live" or "Unsaved".
- A refused publish lists each reference by name and reason.
- The form checks with the API's own schema before sending.

## Alternatives considered

- **"Save & publish" in one step** (the prototype). Rejected: the done condition asks for versioned drafts and a safe preview before anything goes live.
- **Rendering the preview with the storefront's components inside the admin.** Rejected for now. It would pull storefront code and gated catalogue rendering into the admin. Step 99 builds the real sections, and the preview here stays approximate, as in the prototype.
- **A separate image store for content.** Rejected: the pipeline already sanitizes, re-encodes and expires uploads.

## Consequences

- Step 98 reads only published copies and checks every reference again.
- Copy is placeholder until BI-09. Coupon codes and a hero carousel are not offered (BI-13).
