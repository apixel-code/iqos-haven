# 0116 — Category page text, and search titles for brand and category pages

- Status: Accepted (changes "categories mirror brands without a description", steps 48–50; closes "`seo` fields for brands and categories in the store API" left open by ADR 0114)
- Date: 2026-11-14
- Decided by: Marina (SEO plan approved 2026-11-13: sales from organic search only)

## Context

Category pages are the store's pages for searches such as "TEREA Japan" or "IQOS ILUMA i Prime": seven TEREA country categories and six device model categories. Until now such a page had the category name as its title, a generic description, and no text of its own. The Owner could already enter a search title and description for a brand or a category in the admin, but the store never used them. A category had no free text at all; only brands had a description.

## Decision

- **Category text:** `categories.description` (text, up to 10,000 characters, default empty), edited in the admin's category form like a brand's description. Any staff member who may edit categories may edit it. A category update that leaves it out keeps the stored text, so callers written before this ADR keep working.
- **Store reads:** `GET /v1/store/brands` and `/v1/store/categories` now carry `seo { title, description }` (null when not set), and categories carry `description`. Like every store read they need the age ticket.
- **Pages:** a brand or category page uses the Owner's search title when one is set, otherwise the name. The meta description is the Owner's search description, otherwise the start of the page text, otherwise the generic sentence. The category text is shown under the heading.
- **No new permission:** the search title and description stay Owner-only to write (`seo.write`), as before.

## Consequences

- Migration `20261114000100_category_description` is expand-only: one new column with a constant default.
- The text is visible to verified shoppers and, under the `catalogue` policy, to verified search crawlers (ADR 0114). It is never in a link preview or an unverified response.
- The text itself is content, entered through the admin: it is not in the repository.
- During a deploy, for the seconds in which the storefront and the API are on different releases, brand and category pages can answer with the error page (the store contracts are strict in both directions).
