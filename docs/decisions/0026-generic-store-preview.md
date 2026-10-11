# 0026 — Generic store preview, crawler policy and public policy pages

- Date: 2026-10-11
- Status: accepted (policy text and indexing decision pending BI-04/BI-05)
- Step(s): 57 (gate: 56, ADR 0025; product pages: 59–61; SEO editor, sitemap, JSON-LD: 113)

## Context

Roadmap step 57: a generic store preview and public policy pages, such that an unverified product request contains no product name, image, price or JSON-LD, with no User-Agent bypass. Architecture §9 treats search indexing and link previews as separate decisions; launch keeps product content away from both. A browser and a preview fetcher must see the same generic metadata.

BI-05 (link preview and indexing policy) and BI-04 are OPEN. Marina chose on 2026-10-11 to continue with what does not depend on them.

## Decision

**One generic preview for every URL.** The root layout's `generateMetadata` returns the store name, a generic description, `noindex`, and Open Graph/Twitter tags built only from the constants in `lib/site.ts`. The preview image is `/opengraph-image`, drawn from the same constants. An unverified request to any product URL is redirected by the routing gate (ADR 0025) to `/age-check`, so a preview fetcher that follows the redirect ends on this generic page. No code path produces different metadata for a crawler.

**Rule for later pages.** A page may refine its metadata only for requests the gate has let through. Product names, images, prices and JSON-LD must never appear in metadata reachable without a ticket. Because the proxy redirects before any page code runs, page-level `generateMetadata` is never executed for an unverified request.

**Every page is rendered per request** (`dynamic = "force-dynamic"` on the root layout). Nothing is prerendered or shared, which also removes the question of a static page's own cache headers.

**Crawler policy.** `robots.txt` disallows everything and names no sitemap; every response already carries `X-Robots-Tag: noindex, nofollow`. No sitemap is published while the catalogue is closed.

**Public policy pages:** `/responsible-use`, `/terms`, `/privacy`, listed in `POLICY_PAGES` and in the gate's exact public list. They contain no catalogue data. A visitor who answered "under 18" can still read them but cannot reach the age question. Responsible-use shows the prototype's wording; terms and privacy say the text is being finalised instead of inventing legal wording.

**Permanent check.** `pnpm test:age-preview` (part of `pnpm verify`) starts the built storefront with a throwaway key and asserts over HTTP, for eight User-Agents including search and social fetchers:

- every restricted URL redirects to the age check on our own origin, uncacheable and `noindex`;
- the gate page carries the generic tags, none of the forbidden markers (JSON-LD, prices, product Open Graph, microdata), and identical metadata for every agent;
- forged headers, cookies and query flags never count as verification;
- robots, the preview image and the policy pages behave as described.

## Waiting for business input

- **BI-05:** whether products may ever be indexed or previewed. Until then nothing changes here.
- **BI-04 / legal adviser:** final text of the three policy pages, required health-warning wording, contact details and delivery/returns information (those pages are not built yet).
- A real logo for the preview image; the current one is the store name in text.

## Alternatives considered

- **Serving the gate page in place (200) on the product URL instead of redirecting.** Rejected for now: the redirect keeps one gate URL and one code path. Revisit if a preview platform fails to follow redirects on staging.
- **User-Agent allowlist for preview fetchers.** Rejected by architecture: a User-Agent string is never sufficient.
- **Publishing a sitemap of policy pages.** Deferred to step 113; it contradicts `Disallow: /` today.

## Consequences

- WhatsApp/Facebook preview rendering is platform-dependent and must be checked on staging (architecture §9); the local check proves what the server sends, not what a platform shows.
- When product pages arrive (steps 59–61), add real product URLs to `RESTRICTED` in `scripts/check-age-preview.mjs` and add a verified-shopper case.
- Adding a public page means editing `PUBLIC_INFO_PATHS`; the unit test ties it to `POLICY_PAGES`.
