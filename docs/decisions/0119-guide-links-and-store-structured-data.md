# 0119 — Guide links on catalogue pages, and the store's structured data

- Status: Accepted
- Date: 2026-11-14
- Decided by: Marina (SEO plan approved 2026-11-13)

## Context

The guides (ADR 0117) were reachable only from the footer and the guide list. Search engines judge a page partly by the links that point to it, and shoppers on a product page are the ones who need a guide.

## Decision

- **Guide box:** the sticks and devices pages, TEREA and IQOS category and brand pages, and sticks and device product pages show up to three published guides on their topic under the products, with a link to all guides. The topic is the first word of the slug (`terea-…`, `iqos-…`), so a newly published guide joins the right pages and a hidden one drops out. A failed guide read shows no box and never fails the page.
- **Home structured data:** schema.org `Organization` (name, address, logo, area served: UAE) and `WebSite`, only while the Owner offers the catalogue (ADR 0114). No search action: `/search` is not offered to crawlers.
- No API or database change.

## Consequences

- One more store read per page that shows the box (the guide list); it counts toward the same per-address catalogue budget.
- Guide slugs carry meaning: a TEREA guide's slug must start with `terea-`, an ILUMA guide's with `iqos-`, to appear on those pages.
