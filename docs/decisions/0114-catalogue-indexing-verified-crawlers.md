# 0114 — Catalogue indexing for verified search crawlers

- Status: Accepted (changes ADRs 0026 and 0079; changes the age-gate invariant "no bypass"; "the API has no crawler rule of its own" is changed by ADR 0115)
- Date: 2026-11-13
- Decided by: Marina (client decision: sales are to come from organic search, with no paid advertising)

## Context

Until now the store was closed to search engines by decision (BI-05, ADR 0079): `robots.txt` disallowed everything except three policy pages, every catalogue page was `noindex`, and an unverified request never received product data (ADR 0026). The client now wants sales from search alone, which needs product pages in Google and Bing. Architecture §9 allowed this later, for verified crawlers only and never by User-Agent.

Apixel told the client that sources disagree on UAE rules for promoting and selling tobacco products online, and that this needs the client's own legal check. The client decided to open the catalogue.

## Decision

- **Policy:** the indexing policy gets a third value, `catalogue` ("Whole catalogue" in Admin → SEO). It is the Owner's choice like the other two, written with audit and outbox as before. `closed` stays the default and the fallback on any failure.
- **Who passes without the age check:** only a verified search crawler, only for `GET`/`HEAD`, and only on catalogue pages: `/`, `/shop`, `/devices`, `/sticks`, `/brands`, `/offers`, `/help`, `/p/<slug>`, `/p/<slug>/image`, `/brands/<slug>`, `/categories/<slug>`. Cart, checkout, search, saved lists, order pages and the image optimizer are never included.
- **Verification** (`apps/storefront/lib/age/crawler.ts`): the User-Agent (Googlebot, Google-InspectionTool, bingbot) only decides whether to check. Trust comes from DNS, as both engines document: the client address must reverse-resolve to a host under `googlebot.com` or `search.msn.com`, and that host must resolve forward to the same address. `google.com` is not accepted: it also names Google's proxies that fetch pages for any person (a translated page, for one). The address is the gateway's `X-IH-Client-IP`, which a browser cannot set. A failure or a 2-second timeout is a refusal. A verified address is held for 6 hours, a refusal for 5 minutes.
- **How the crawler reads:** the routing gate mints a normal age ticket that lasts 10 minutes and adds it to the request, so the pages and the API (which still verifies a ticket on every read) work unchanged. The same ticket is set as a cookie so what the crawler's page loads afterwards also works. The API has no crawler rule of its own.
- **Visitors:** nothing changes. A person arriving from a search result is sent to the age check and then back to the page. A crawler's name from any other address is gated like anyone else.
- **`noindex`:** the routing gate now sets `X-Robots-Tag: noindex` on every response whose exact path the policy does not offer (it was a static header before). The gate passes its decision to the page in a request header (`x-ih-indexable`, always overwritten), and the root layout turns it into the robots meta.
- **robots.txt and sitemap:** under `catalogue`, `robots.txt` allows the store except the shopper's own pages and the gate, and `sitemap.xml` lists the catalogue pages, every brand and category with products, every published product and the policy pages. The sitemap reads the catalogue with a ticket minted for that one request and passes the requester's address on, so the API's per-address limit applies.
- **Structured data:** product pages carry schema.org `Product` (name, description, brand, price in AED from integer fils, availability, rating from approved reviews) and `BreadcrumbList`, only under `catalogue`.
- **Pictures:** storage links are signed and expire in minutes, so structured data names `/p/<slug>/image`, which redirects to a fresh link.
- **Page text:** product pages fall back to the start of the description for the meta description; listing, brand and category pages get a description and a canonical address.
- **Link previews stay generic:** a link shared in a chat still shows the store preview only. Preview fetchers are not verified crawlers.

## Consequences

- Under `catalogue`, product names, pictures and prices are public in search results and in the sitemap. "Unverified = zero product data" now means: no product data to anyone but a verified shopper or a DNS-verified search crawler while the Owner offers the catalogue.
- The gate reads the public indexing policy for every request (held 60 seconds per process), and does two DNS lookups the first time a crawler-named address appears.
- There is no CDN, so the crawler is verified in the storefront gate, not at an edge. The storefront is reachable only through the gateway. If a CDN is added, the address header must be re-established first.
- Crawler responses are `private, no-store` like every gated response.
- Not built: verified link-preview fetchers, product pictures in the sitemap, Arabic pages, and `seo` fields for brands and categories in the store API.
- Turning the policy back to `closed` or `public_pages` closes everything again within a minute.
