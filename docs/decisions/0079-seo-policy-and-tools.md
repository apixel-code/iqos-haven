# 0079 — SEO policy, issue report, public sitemap and the SEO screen

- Date: 2026-10-16
- Status: accepted (product indexing still waits for BI-05)
- Step(s): 113 (follows ADRs 0026 and 0068)

## Context

Roadmap step 113 has four parts: the Owner's SEO editor and issue report, a public sitemap, and gated product metadata. Its done condition is that generic previews and base canonicals are active, and that product indexing and JSON-LD are activated only once a policy is approved.

Architecture §9 sets the launch baseline: "Product indexing off; public pages sitemap only". It also says that features which are not available must be labelled inactive, not presented as working SEO. ADR 0026 left the sitemap to this step and kept `Disallow: /` plus `noindex` everywhere. BI-05, the decision on product indexing and previews, is still OPEN.

## Decision

**Indexing policy.** The policy is stored in a new `seo` settings row (migration `20261016000500_seo_policy` allows the key). It is not shown on the general Settings screen. There are two choices:

| Policy                     | robots.txt                                                                    | sitemap.xml            | Policy pages                      |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------- | --------------------------------- |
| `closed` (default, no row) | `Disallow: /`, no sitemap                                                     | empty                  | `noindex` header and meta         |
| `public_pages`             | `Allow:` /responsible-use, /terms, /privacy; `Disallow: /`; names the sitemap | those three pages only | `index` meta, no `noindex` header |

- **Never offered:** catalogue pages stay gated and `noindex` under either policy. Product indexing, product previews and JSON-LD are not choices at all.
- **Writing:** `PUT /v1/admin/seo/policy` (`seo.write`, at an expected version) locks the actor and the row, and writes an audit entry and `seo.policy_updated` in the same transaction. Setting the same value again changes nothing.
- **Reading:** `GET /v1/public/seo` (public, `max-age=60`) returns only the policy.
- **Storefront:**
  - The storefront reads the policy server-side and holds it for `SEO_POLICY_CACHE_SECONDS` (default 60).
  - Any failure or unexpected answer means `closed`, so a fault never opens the store to crawlers.
  - The policy pages' `X-Robots-Tag` moved from the static config to the routing proxy, which decides it from the policy. Every other path keeps the static `noindex`. The static rule matches without regard to case, so the proxy also sets `noindex` on any other spelling of the three paths (`/Terms`); only the exact lower-case page may go without it.
  - `/sitemap.xml` is public (gate list).

**Overview.** `GET /v1/admin/seo` (`seo.write`) returns the policy and the real state of each feature. Generic previews, canonical addresses and slug redirects are active. The public sitemap is active only with `public_pages`. Product indexing, product previews and product JSON-LD are always inactive, each with its reason.

**Issue report.** `GET /v1/admin/seo/issues` (`seo.reports`) checks published products and active brands and categories, none in the bin, in one snapshot:

- a missing SEO title (the name is used) or description (the generic text is used);
- a title over 60 characters or a description over 160;
- duplicate titles across all three page types, comparing the title each page would show, case-insensitively.

At most 200 items are returned, duplicates and length problems first. The SEO fields themselves stay on each product, brand and category (Owner-only, ADRs 0014–0015).

**SEO screen** (`seo.write`; the report needs `seo.reports`):

- Two labelled choices, with a confirmation before each change.
- A list of what is active, with text labels (not colour alone).
- The issue report, as a table.

Product indexing is shown only as an inactive feature with its reason, never as a switch.

**Permanent check.** `pnpm test:age-preview` covers the policy:

- **Closed, and with the API down:** robots disallows everything and names no sitemap; the sitemap is empty; the policy pages carry `noindex` in both the header and the meta tag.
- **Public pages:** robots allows exactly the three pages and names the sitemap; the sitemap lists exactly those three on our origin; the pages have `index` meta and no `noindex` header; a catalogue page stays `noindex`.

## Waiting for business input

**BI-05:** whether products may ever be indexed or previewed. Turning that on needs:

- the decision itself;
- a trusted verified-crawler edge, never a User-Agent check;
- a product sitemap and JSON-LD;
- tests of exactly what each audience may see.

None of that is built, and the screen says so.

## Consequences

- The default stays exactly as before (closed) until the Owner chooses "Public pages". Marina may choose it; it exposes no catalogue data.
- Steps 114 (the acceptance pass) and 118 (regression) should include the policy flip.
