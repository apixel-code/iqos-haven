# 0068 — Slug changes are the Owner's; former slugs and canonical URLs

- Date: 2026-10-15
- Status: accepted
- Step(s): 101

## Context

Roadmap step 101 has this done condition: slug cycles and chains are prevented, the canonical URL resolves to the current slug, and Staff cannot change SEO fields.

The architecture's permission matrix (§11) gives "SEO fields, redirects administration and SEO reports" to the Owner and not to Staff. What already existed:

- SEO fields required `seo.write` to read and to write.
- Every slug change wrote an `slug_redirects` alias that points straight at the entity, so redirects cannot chain or loop. The `catalogue_slug_claim` trigger serialises slug claims, and an entity can take back its own former slug.

What was missing:

- Any catalogue editor with `catalog.write` could change an existing slug, which creates a redirect.
- Former brand and category slugs answered 404 in the store; only product pages redirected.
- No page declared a canonical URL.

## Decision

- **Changing an existing slug** of a product, brand or category requires `seo.write`, checked in the update transaction after the actor lock. Creating an entity with a slug stays catalogue work. The admin shows the slug read-only to editors without `seo.write`, but the server's 403 is what enforces it.
  - The products path checks this permission before the version, so a Staff user always gets 403.
  - The brand and category path checks the version first, so a stale Staff edit gets 409. Either way nothing changes and nothing leaks.
- **Former slugs:** the store brand and category lists carry `formerSlugs`, the newest 20, for visible parents only. The storefront brand and category pages permanently redirect a former slug to the current one, as product pages already did. Older aliases still reserve their slug but no longer redirect. That is an accepted limit: only the Owner renames now.
- **Canonical:** product, brand and category pages declare their current slug as canonical (resolved against `metadataBase`). Like the titles, these are rendered only for verified shoppers, and previews stay generic.
- **Cache:** `CATALOGUE_CACHE_VERSION` goes to 3, because the shape of the brand and category answers changed.

## Consequences

- Staff edits that keep the slug unchanged work as before.
- A slug filter on listings (`/shop?brand=<old>`) does not resolve former slugs: such a link shows no products rather than redirecting.
