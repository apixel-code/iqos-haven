# 0086 — Listing-page filters through browsing search

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-S2 (follows ADRs 0028, 0029 and 0027)

## Context

The search page had every filter, with counts per choice: type, brand, price, puff count, nicotine, stock and sale. The listing pages (`/shop`, the two type pages, brand and category pages, offers) only had sort, type and brand. The prototype offers the full set on every listing. Marina chose G-S2 for launch (2026-10-17).

The search route had a tighter budget than the listing route (60 versus 240 requests a minute per address) and no cache, because free text would only fill a cache with other people's typos. Listing pages carry most of the traffic, and many UAE phones share one address behind carrier NAT. Moving listings onto search unchanged would have hurt both.

## Decision

- **Listing pages use the search route** with their fixed scope (`type`, `brand`, `category` or the offers flag) and the shopper's filters. The search filter panel serves both pages:
  - it hides the facet a page fixes;
  - it submits to the page's own path;
  - a page's links never repeat its fixed values.
- **`category`** is added to the search query as a scope that applies to every count. It is not a facet.
- **Browsing is a catalogue read.** A search request without a term uses the catalogue budget (`STORE_CATALOG_POLICY`). Its first page is cached in the catalogue cache under a key built from validated, normalized values, with later pages read directly, as for listings. Any catalogue change drops the whole cache, as before. A request with a typed term keeps the search budget and is never cached.
- **Old listing links keep working:** `?brand=&sort=&type=` mean the same thing. A cursor from the old listing route is malformed for search; it restarts the list instead of failing.
- The old listing controls (`ListingControls`, `ProductListing`, `parseListing`, `listingHref`) are removed.

## Consequences

- Every listing page offers the full filter set with counts, and phones get the same collapsible panel as search.
- Listing traffic keeps the catalogue budget and cache; typed search keeps its tighter guard.
- Listings now run the facet query (counts per choice). The step 121 load test measured termless search at p95 under 50 ms, and first pages come from the cache.
