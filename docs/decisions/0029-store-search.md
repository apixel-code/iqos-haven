# 0029 — Store search, suggestions and facets

- Date: 2026-10-11
- Status: accepted
- Step(s): 60 (search analytics `search_daily`: 106; external search engine: only after measurement, architecture §13)

## Context

Roadmap step 60: search, suggestions, facets and sort with PostgreSQL full-text search and trigram matching, allowed sort fields, correct counts, defined no-result behaviour and no unchecked SQL identifiers. Architecture §5 asks for a GIN `tsvector` document, a trigram index on normalized text and bounded term length; §10 asks for facet counts with documented applied-filter semantics.

## Decision

**Projection.** `product_search` holds one row per product: `search_text` (lower-cased product, brand and category names, type words, puff count as "7000 7k puffs", and the option values of active variants) and a weighted `tsvector` (`simple` configuration: names A, option values B, the rest C). Database triggers on products, variants, brands and categories keep it current; the application never writes it. It is derived data, so it is deleted with its product. It grants no visibility: every search joins the store visibility rule (ADR 0027).

**`pg_trgm`** is installed in schema `public` and always referenced schema-qualified, so it works whatever schema the tables are in (tests use one schema per file). The migration takes an advisory lock so concurrent installers do not collide.

**Text from the shopper** is reduced by `normalizeSearchTerm` (`@ih/domain`) to at most six lower-cased tokens of letters and digits, 64 characters in total, before any SQL sees it. Operators, quotes, wildcards and control characters cannot survive. The request text is otherwise only ever a bound parameter.

**Matching, in two passes:**

1. _Exact:_ every token must match a word by prefix (`to_tsquery('simple', "'tok':* & …")`), ranked by `ts_rank`.
2. _Approximate_, only when the exact pass matches nothing at all: every token must still be accounted for. A word of three or more letters matches by trigram word similarity (threshold 0.35); a token containing a digit must match exactly by prefix, because a puff count or strength is never "roughly" right. The response says `approximate: true` and the page says "Showing similar results".

A real match is therefore never diluted by look-alikes ("mint" does not return "Mini").

**Filters:** type, brands (up to 10), price range in fils, puff range, nicotine values (the `nicotine` option of active variants), in stock, on sale.

**Facet counts** (disjunctive): each facet is counted with every other filter applied and its own ignored, so the alternatives inside a facet stay visible while one is selected. `total` counts products matching every filter. A product with two nicotine strengths counts under both. The price facet is the lowest and highest price the other filters leave.

**Sorts:** `relevance` (default with a term), `newest` (default without), `price_asc`, `price_desc`, `name`. Sort expressions and directions are a fixed table in code. Paging is keyset on (sort key, product ID); relevance uses an integer rank so the cursor is stable. Cursors are validated before any query and refused for a different sort. A cursor also records whether its page came from the near-miss pass, so later pages stay in the same result set if the catalogue changes in between. The storefront restarts a list at its first page when the API refuses a cursor (an old bookmark).

**Suggestions:** `GET /v1/store/search/suggest?q=` returns up to six products and four brands for a term of two or more characters, with the same two-pass matching and visibility.

**Controls:** both routes are `@AgeVerified()`, `private, no-store`, contract-serialized. Results are **not cached** (free-form text; ADR 0027's reasoning), so the limits are tighter: 60 searches and 120 suggestions per minute per client address.

**Storefront:** `/search` (prototype URL) with a header search field, a plain GET filter form (works without JavaScript), total, paging, a no-result state and the near-miss notice. Prices are typed in whole dirhams and converted to fils on the server. The search term never appears in the page title. Suggestions are fetched by the browser from the same-origin API route, which checks the age ticket itself.

## Alternatives considered

- **Always mixing trigram matches into results.** Rejected after testing: "mint" returned "Halo Mini" and numbers matched other numbers.
- **`english` stemming.** Rejected: product and flavour names are not prose; prefix matching covers plurals well enough.
- **Trigger-maintained columns on `products`.** Rejected: an update of the product row from its own trigger would interact with the publication and version triggers.
- **Caching search results.** Rejected: unbounded key space.
- **Price buckets.** Deferred: the prototype's ranges are demo data; a min/max range needs no business decision.

## Consequences

- Each search runs two statements (page and facets) over the matched set, plus a second pass for near misses. This is sized for a catalogue of hundreds to low thousands of products; measure before going further (architecture §13).
- The `nicotine` facet depends on products using an option named exactly `nicotine`; other option names are searchable but not facets.
- Search reflects catalogue changes immediately (no cache), unlike listings, which follow cache invalidation.
- No search analytics are recorded yet (step 106); the no-result rate is not measured.
- The listing pages (`/shop`, type, brand, category) keep their simple controls; `/search` without a term is the faceted way to browse.
- Applying migrations now requires the right to create a trusted extension in the database. The migration fails with a clear message if `pg_trgm` already exists in a schema other than `public`.
- A request refused by validation (400) is answered before the per-address limiter counts it; it costs no query.
