# 0120 — Arabic landing pages

- Status: Accepted
- Date: 2026-11-14
- Decided by: Marina (chose the smaller option: main pages in Arabic, not the whole store)

## Context

Part of the UAE searches in Arabic ("ايكوس", "تيريا"). The store was English only.

## Decision

- **Pages under `/ar`:** `/ar` (home: editions, models, a row of sticks and of devices, delivery), `/ar/sticks`, `/ar/devices`, `/ar/categories/<slug>` (TEREA editions and ILUMA models only), `/ar/delivery` and `/ar/delivery/<emirate>`.
- **Arabic around the facts:** headings and sentences are Arabic copy in `apps/storefront/lib/ar.ts`; products, categories, fee, time and areas come from the API as on the English pages. Brand, product and area names stay in Latin letters. The page content is `lang="ar" dir="rtl"`; the shared header, footer, filters and product cards stay English for now, and so do the age check, cart and checkout.
- **Pairs:** the English and Arabic version of a page name each other with hreflang alternates (`en`, `ar`, `x-default` = English); each is its own canonical. A category without an Arabic heading has no Arabic page (404) and no alternate.
- **Indexing:** catalogue pages for ADR 0114 (gated for visitors, readable by verified crawlers under `catalogue`), in the sitemap. Linked from the footer and the mobile menu ("العربية").
- No API or database change.

## Consequences

- The Arabic copy should be read by a native speaker; it is in one file so it can be corrected in one place.
- Guides stay English: an Arabic guide would be a separate guide written in Arabic in the admin.
- The whole store in Arabic (cart, checkout, product texts, gate page) remains a separate, larger decision.
