# 0027 — Gated store catalogue read API

- Date: 2026-10-11
- Status: accepted
- Step(s): 58 (pages: 59, 61; search: 60; cart/quote: 65+)

## Context

Roadmap step 58: catalogue read APIs for shoppers that return published, active, non-deleted data only, with private/no-store responses and bounded query input. Architecture §10 lists `GET /store/products`, `/products/:slug`, `/brands`, `/categories`; §9 makes the API the catalogue cache owner and requires the age check before any response, cached or not.

## Decision

**Routes** (`StoreCatalogController`, all `@AgeVerified()` + `@Serialize`):

| Route                          | Returns                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/store/brands`         | Active, non-trashed brands with their visible product count                                            |
| `GET /v1/store/categories`     | The same for categories                                                                                |
| `GET /v1/store/products`       | One page of product cards; filters `brand`, `category` (slugs), `type`; `sort`; `limit` ≤ 48; `cursor` |
| `GET /v1/store/products/:slug` | One product with options, active variants and images                                                   |

**One visibility rule**, defined once in `packages/db/src/store-catalogue.ts` and used by every query: a product is visible when it is published, not trashed, its brand and category are both active and not trashed, and it has at least one active variant. Only active variants are returned. Unknown, draft, trashed and hidden-parent products all answer the same 404.

**What a shopper gets.** Names, slugs, type, puff count, description, typed specs, Owner SEO text, options, and per active variant: ID, attributes, price in fils and `available`. No SKU, stock count, threshold, version, tax reference or staff data. `available` and `soldOut` come from `productAvailability` (ADR 0023/step 54); zero stock never hides a product or option.

**Prices.** A variant's price is its override or the product base price. A card shows `priceFromFils`, the lowest price among active variants. `compareAtPriceFils` is returned only when it is above the price it sits next to. All integer fils; the server quote (step 65+) stays the only authority for what is charged.

**Images.** Short-lived (10 min) signed links to the sanitized derivatives in the private media bucket, primary image first. No public bucket or CDN is involved yet (BI-06).

**Bounded input.** Strict query schema: unknown or repeated parameters are refused; slugs must match the catalogue slug pattern; `sort` is one of four names mapped to fixed SQL; `limit` 1–48. The cursor is an opaque position issued by the API (sort, key, product ID); it is length-bounded, validated before any load (price keys within the column range, text keys without control characters), and refused for a different sort. Every sort ends on the product ID.

**Former slugs.** A product is also found by a slug it used to have; the response carries the current slug and the page redirects. A redirect never reveals a hidden product.

**Cache.** Brands, categories, first pages of product lists and found products go through `CatalogueCacheService` with keys built from validated input (`store:brands`, `store:categories`, `store:products:<fields>`, `store:product:<slug>`). Two things are deliberately not cached, because a client could otherwise fill the cache with entries nobody else asks for: a product lookup that finds nothing, and list pages reached through a cursor. Both are single indexed reads behind the per-address limit. The age guard runs before the controller, so a cache hit is never served without a ticket. Admin catalogue changes drop the cache after commit and through the worker (ADR 0022).

**Responses** carry `Cache-Control: private, no-store` and `Vary: Cookie`, including limiter and error answers.

**Rate limit.** 240 reads per minute per client address; when the shared limiter is unavailable, a bounded local budget plus a process ceiling (browsing must not close with the limiter). A full miss queue answers 503 with `Retry-After`.

## Alternatives considered

- **Offset pagination.** Rejected: architecture §10 asks for stable keyset ordering.
- **Exposing stock counts** for "only 3 left" messaging. Not now: it is business information the prototype does not need; add a coarse signal later if wanted.
- **Hiding products of inactive brands only from navigation.** Rejected: "inactive" would then still sell; one rule is easier to reason about.
- **Public image URLs.** Deferred to the CDN decision (BI-06).

## Consequences

- Displayed availability and prices may lag a stock movement by up to the cache TTL (60 s); stock changes do not invalidate the cache (ADR 0022). Checkout reads PostgreSQL.
- Signed image links expire after 10 minutes; a page left open longer needs a reload to show images again. Revisit with the CDN.
- The client address comes from `X-IH-Client-IP`, as on admin routes; the API must stay private behind the gateway and the storefront must forward the shopper's address when it calls server-side (step 59).
- Published products cannot be created through the admin until BI-02; tests seed them directly.
- "Newest" orders by product ID (time-ordered UUIDv7), not by publication date; a publication timestamp can replace it when products are published in a different order than they are created.
- Stored specs that do not fit the contract are shown as no specifications and logged, instead of failing the product page.
- The query schema is strict: the storefront must not forward tracking parameters (`utm_*`, `fbclid`) to the API.
- Brand logos and category images have no upload pipeline yet, so they are not returned.
