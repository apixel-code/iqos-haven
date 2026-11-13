# 0115 — Crawler mark on the age ticket: own read budget, no browsing statistics

- Status: Accepted (changes ADR 0114 "the API has no crawler rule of its own"; extends the ticket format of ADR 0024)
- Date: 2026-11-14
- Decided by: Marina (after the first day of the open index)

## Context

On the first day of the `catalogue` policy (ADR 0114) two things showed up on production:

- Catalogue reads are limited to 240 a minute per client address. A page costs about six reads, so one address gets about forty pages a minute. Past that the API answers 429 and the storefront shows its error page with status 500. A sweep of the 99 sitemap addresses from one machine hit it after 41 pages. A search crawler that fetches quickly from one address would get the same error pages.
- Google renders pages like a browser, so its renderer posts `POST /v1/store/events`. Crawler visits were counted as product views.

The API could not tell a crawler from a shopper: the routing gate gave both the same ticket.

## Decision

- **Signed mark:** the pass the routing gate mints for a DNS-verified crawler carries one extra claim, `via: "crawler"`. A ticket has exactly the six shopper claims, or those six plus this mark; anything else is refused as before. The mark is under the Ed25519 signature, so only the storefront signer can set it. A marked ticket may last at most one hour (the gate mints 10 minutes).
- **Read budget:** on catalogue reads (`store/info`, brands, categories, products, home, browse), a marked ticket is counted under its own limit, `store_catalog_crawler`: 1200 a minute per address (about two hundred pages), 600 in the limiter-outage fallback. Shoppers keep 240. Search, suggestions, quotes, cart and checkout limits are unchanged for everyone.
- **Statistics:** `POST /v1/store/events` answers a marked ticket with 202 and `dropped`, and stores nothing.
- **Nothing by name:** the User-Agent still grants nothing, in the gate or in the API.
- **Status code:** the storefront still answers 500 when the API limits a page. Next.js cannot set 429 from a page render, and search engines treat 429 and 5xx the same way (slow down, retry later). The larger budget is what keeps crawlers away from that page.

## Consequences

- A marked ticket is useful only to the crawler that received it, for 10 minutes: it buys a larger read budget and silence in statistics, and no data a shopper's ticket does not also give.
- Rollout: an API that predates this ADR refuses a seven-claim ticket. While a deploy swaps containers (seconds), a crawler can be sent to the age check once; it retries later. The same holds for a rollback.
- The mark makes crawler reads visible in the limiter's metrics under their own endpoint name.
- Views counted before this change (2026-11-13/14) include a few crawler renders.
