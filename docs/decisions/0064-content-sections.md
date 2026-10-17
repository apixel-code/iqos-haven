# 0064 — Storefront content sections: schemas and draft/published storage

- Date: 2026-10-15
- Status: accepted
- Step(s): 96 (editor and APIs: 97; public read: 98)

## Context

Roadmap step 96 asks for seven content-section schemas (ticker, hero, featured, best sellers, brands, campaign banner, offers) with draft and published storage, schema versions and asset references. Architecture §5 lists `content_sections` with a unique section key, schema version, validated draft and published JSON, a version, and who published and when. Content must have no arbitrary HTML and no page builder (step 97).

The admin prototype (`VIEWS.content`) and the storefront prototype disagree in places, and both carry demo traps:

- **Ticker:** the storefront ticker holds HTML strings and bolds demo coupon codes.
- **Hero:** the storefront has a three-slide carousel with a computed discount; the admin model has a single hero.
- **Campaign banners:** the admin has two banners. One of them advertises free delivery, which is off by default. The storefront has one hard-coded Vektor coupon banner with a fake end date.
- **Offers:** offers highlight coupon codes.
- **Images:** images are base64 data URLs with no alt text.

## Decision

**Table `content_sections`** (migration `20261015000400_content_sections`). Each row holds:

- a UUID and a unique `key`, one of the seven;
- `schema_version` and a `draft` object of at most 32 KB, with who saved it and when;
- `published`, `published_schema_version`, `published_by` and `published_at`, which are all null or all set;
- a `version`.

A trigger enforces these rules:

- A section starts as an unpublished draft at version 1.
- Every change advances the version by one, and the key and ID never change.
- Publishing sets `published` to the current draft at its schema version, with a new publish time. The published copy can only be a draft that existed.
- Once published, a section stays published; hiding is a field of the content.
- No row is deleted, and the runtime role cannot delete or truncate.

**Schemas** (`packages/contracts/src/content.ts`). `CONTENT_SCHEMAS[key][version]`; every key is at version 1. A released version is never edited: a change adds a version, and a stored document is always read with the schema that wrote it.

All text is one trimmed line of plain text. It refuses `<` and `>`, control characters, and invisible or direction-changing marks. Links are internal and by ID: shop, category, brand or product. An image is `{ assetId, alt }`. Lists are unique and bounded:

| Section         | Content                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ticker          | `enabled`, 2–6 messages of up to 90 characters                                                                                     |
| hero            | One hero: optional eyebrow (40), title (60), optional subtitle (160), an optional button (label 30 and link) and an optional image |
| featured        | Up to 8 products                                                                                                                   |
| best_sellers    | `auto` (no list; units sold in the last 30 days, computed by the read side) or `manual` with up to 8 products                      |
| brands          | Up to 24 brands                                                                                                                    |
| campaign_banner | Up to 2 banners, each with `enabled`, title, subtitle, button and image                                                            |
| offers          | `enabled`, title, up to 6 products; no coupon codes                                                                                |

**References.** `contentReferences(document)` collects the product, brand, category and image IDs.

- `checkContentReferences` reports each reference that cannot be shown: a product that is not visible to shoppers (the same rule as the catalogue), a brand or category that is inactive or trashed, or an image that is not a ready content image. Each problem is reported as missing, not visible or not ready.
- Drafts may hold such references, because a product can be prepared before it is published. Publishing refuses them, and step 98's read side checks them again.

**Content images.** `media_assets` gains `purpose` (`product` or `content`). `product_id` becomes nullable, and a check ties `purpose = 'product'` to having a product. A ready content image used by a published section cannot leave `ready`, enforced by a trigger.

**Storage functions** (`packages/db/src/content.ts`). All three require `content.manage`, which only the Owner holds.

- `listContentSections` returns the saved sections.
- `saveContentDraft(key, expectedVersion, content)` parses the content at the current schema version. `expectedVersion` 0 means a new section, and a mismatch is `VERSION_CONFLICT`. It writes an audit entry.
- `publishContentSection(key, expectedVersion)` locks the actor, then the row. It refuses a version mismatch (`VERSION_CONFLICT`) and a draft that is already published (`NOTHING_TO_PUBLISH`), then checks the references. It writes the published copy, an audit entry and `content.published` (`contentId`) in one transaction. The event's `storefront_revalidate` consumer arrives with the public read (planned).

## Alternatives considered

- **Free HTML or Markdown fields.** Rejected: it is a page builder by another name, and the prototype ticker shows the risk.
- **Slugs in links.** Rejected: slugs change. IDs resolve to the current slug, and a hidden target is caught at publish and at read time.
- **A content table per section.** Rejected: seven fixed documents with versioned schemas are simpler, and the database still guards publishing.
- **A separate media table for content.** Rejected: the existing upload, processing, derivative and purge pipeline applies as it is. Only ownership differs.

## Consequences

- **Open with the client (BI-13):** whether the Offers section may show coupon codes, and whether the hero should be a carousel. Either is a new schema version.
- **Copy:** none is seeded. Wording that mentions free delivery should not be used while the threshold is off (step 100).
- **Step 97** adds the routes, a content-image upload (purpose `content`, no product), preview and the editor.
- **Step 98** adds the public read, which skips references that have become invalid since publishing. That re-check is the real guarantee: publishing reads the catalogue without locking it, so a product can be hidden or trashed between the check and the commit. Images are guarded by the database.
- References are checked even inside a disabled banner or section, so a disabled banner pointing at an unpublished product blocks publishing. This is kept on purpose: switching the banner on later needs no second check.
- Product media routes see product assets only (`purpose='product'`). The worker writes content derivatives under `content/<asset id>/`.
