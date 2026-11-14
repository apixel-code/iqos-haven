# 0117 — Guides: articles for the store, written in the admin

- Status: Accepted
- Date: 2026-11-14
- Decided by: Marina (SEO plan approved 2026-11-13: sales from organic search only, two guides a week)

## Context

The SEO plan depends on articles: how the ILUMA models differ, what each TEREA edition tastes like, how ordering works in the UAE. The store had no place to publish them; the only editable content was the fixed home sections.

## Decision

- **Table `guides`** (expand-only migration `20261114000200_guides`): slug, title, summary, body, published, first publish date, version. Never deleted: a guide is hidden instead (the runtime role has no DELETE). Once published, a guide's slug cannot change (`GUIDE_SLUG_LOCKED`), so links and search results keep working.
- **Text format:** plain text with a small fixed markup, never HTML: blank lines between blocks, `##`/`###` headings, `- ` and `1. ` lists, `**bold**`, and `[text](/path)` links to store pages only. One parser (`readGuideBody` in `@ih/contracts`) is used by the API to validate, by the admin to show problems while typing, and by the store to render. React escapes all text.
- **Admin:** Storefront → Guides, `content.manage` (Owner only), like the rest of the storefront content. Every change is one transaction with an audit entry (facts only, not the text) and a `guide.updated` event (no consumers yet).
- **Store API:** `GET /v1/store/guides` and `/v1/store/guides/:slug`, behind the age ticket and the catalogue read limit like every store read. A hidden guide answers like an unknown one. Not cached: the table is small.
- **Store pages:** `/guides` (list) and `/guides/<slug>`. They are catalogue pages for ADR 0114: gated for visitors, readable by DNS-verified crawlers under the `catalogue` policy, listed in the sitemap, with schema.org `Article` and `BreadcrumbList` data. Linked from the footer and the mobile menu under Help.

## Consequences

- Guides mention products, so they stay behind the age gate like the catalogue: visitors from search pass the age check first.
- Guides have no pictures yet; a cover image can be added later with the existing content media.
- The texts are content entered through the admin, not kept in the repository.
