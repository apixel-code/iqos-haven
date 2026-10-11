# 0028 — Storefront product listing, brand and category pages

- Date: 2026-10-11
- Status: accepted
- Step(s): 59 (API: 58, ADR 0027; search: 60; product page: 61; navigation shell: 64)

## Context

Roadmap step 59: product list, category and brand pages that are responsive, paginated, show badges, have loading, empty and error states, and never let cached data bypass the age gate. The prototype defines the look: one listing view reused for "all products", the two product types and a brand, plus a brands index.

## Decision

**Pages** (all under the routing gate, rendered per request):

| Path                              | Content                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `/shop`                           | All products; shopper chooses type, brand and sort                    |
| `/disposable-vapes`, `/vape-kits` | The two product types (prototype URLs); the type is fixed by the path |
| `/brands`                         | Brand tiles with product counts, then the two types                   |
| `/brands/[slug]`                  | Brand header (name, description, count) and its products              |
| `/categories/[slug]`              | Products of an admin-managed category                                 |

One `ListingPage` implements every product list. A page's fixed filter always wins over the address bar.

**Data access.** Server components call the API from the server (`lib/store/api.ts`) with `cache: "no-store"`. The storefront keeps no catalogue cache. Per call it forwards exactly two things from the shopper's request: the `ih_age` ticket and the gateway's client address. No other cookie, header or query parameter is forwarded. With no ticket the client does not call the API at all. A response that does not match the contract is treated as an outage and never rendered.

**Three independent age checks** on a catalogue page: the routing gate before rendering, the client refusing to call without a ticket, and the API verifying the ticket on every read (cache hits included). If the API refuses a ticket the gate accepted, the shopper is redirected to the age check.

**Address-bar input** is reduced by `parseListing` to brand slug, type, one of four sorts and a cursor; tracking parameters and unknown or repeated values are dropped and never reach links, forms or the API.

**No streaming for these pages.** There is deliberately no `loading.tsx`: with it Next answers 200 before the data is known and finishes a missing page, a redirect or an error in JavaScript. Rendering in full gives a real 404, a real redirect and a real 500, and the pages work without JavaScript. The loading state is shown on what the shopper pressed: pagination links say "Loading…" and the controls say "Updating…" while the next list is fetched.

**Paging** is forward-only with the API's keyset cursor: "Next page" and "Back to the start". No total count is shown, because the API does not compute one.

**Card** follows the prototype: 4:5 image tile, badges ("Sold out" replaces the others; "−N%" and "New" may sit together), brand, two-line name linking the whole card, a mono line ("7K puffs · 6 options"), the lowest price with the previous price struck through. Prices are formatted from integer fils without floating point; whole dirhams show no decimals. Images are plain `<img>` elements with the API's signed links; the Next image optimizer is not used.

**States.** Empty list (with "Clear all filters" when filters are active), end of list, unknown brand or category (404 page), and API failure (error page with "Try again", no technical detail).

## Not built here (later steps or missing data)

- Price, puff-count, strength, in-stock and on-sale filters, "Featured" and "Best selling" sorts, the mobile filter sheet and filter chips: the API has no such facets yet (search and facets are step 60).
- Wishlist heart and quick-add on the card (cart and device state, steps 62–63).
- Offers page with promo codes (prototype trap: demo coupons).
- Header, search, cart, footer content (step 64). A minimal header keeps the pages reachable.
- Product links point to `/p/[slug]`, which arrives in step 61.
- Brand logos and wordmark styles (no asset pipeline for brands yet).

## Alternatives considered

- **Browser-side fetch to `/api/v1/store/*`.** Rejected for listings: server rendering keeps the pages working without JavaScript and keeps the catalogue out of client bundles and caches.
- **Streaming with skeletons.** Rejected for document requests, as explained above; the skeleton component is kept for client-side use later.
- **Numbered pages.** Rejected: the API is keyset-only (ADR 0027).

## Consequences

- Each listing page costs one or two API reads per request; first pages are cached by the API.
- `pnpm test:age-preview` now renders these pages against a stub API for a verified shopper and re-checks that the next unverified request is refused without any API call.
- `pnpm test:age-preview -- --serve` keeps the storefront and the stub running for a manual look.
- A shopper who answered "under 18" cannot reach any of these pages (ADR 0025).
- The client address forwarded to the API is the one the gateway set. As for the age routes (ADR 0025), the storefront port must be reachable only from the gateway; otherwise a client could choose the address the API limits by.
