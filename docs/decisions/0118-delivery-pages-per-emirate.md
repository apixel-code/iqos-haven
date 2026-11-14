# 0118 — Delivery pages per emirate

- Status: Accepted
- Date: 2026-11-14
- Decided by: Marina (SEO plan approved 2026-11-13)

## Context

Shoppers search for delivery in their own emirate ("IQOS delivery Dubai", "TEREA Sharjah"). The store had one help page for all of the UAE.

## Decision

- **Pages:** `/delivery` lists the emirates served; `/delivery/<emirate>` (`dubai`, `abu-dhabi`, `sharjah`, `ajman`, `umm-al-quwain`, `ras-al-khaimah`, `fujairah`) shows that emirate's fee, delivery time and active areas, how to pay, and links to devices, sticks and the two guides.
- **Facts from the settings only:** fee, free-delivery threshold, time and areas come from the Owner's delivery settings through `GET /v1/store/delivery`. A page exists only while the emirate has at least one active area; otherwise it answers 404 and is not in the sitemap. No local claims are written in copy.
- **Indexing:** catalogue pages for ADR 0114 (gated for visitors, readable by verified crawlers under `catalogue`), in the sitemap, with `BreadcrumbList` data. Linked from the footer and the mobile menu.
- No API or database change.

## Consequences

- When the Owner adds or switches off areas in Admin → Delivery, the pages and the sitemap follow within the API cache time.
- On 2026-11-14 production serves Dubai (25 areas), Abu Dhabi, Sharjah and Ajman (one area each); Umm Al Quwain, Ras Al Khaimah and Fujairah get pages once areas are added there.
- The pages link to the two first guides by their slugs; if one is hidden, its link answers 404 until it is shown again.
