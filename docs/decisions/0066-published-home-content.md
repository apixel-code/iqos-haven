# 0066 — Published home content read

- Date: 2026-10-15
- Status: accepted
- Step(s): 98 (storage: ADR 0064; editor: ADR 0065; home page: 99)

## Context

Roadmap step 98 has this done condition: a draft is never public, and the store gets one assembled content response whose product and media references are valid.

Publishing checks references without locking the catalogue (ADR 0064). After publishing, a product can be unpublished, a brand hidden or a category trashed, so the read must check every reference again.

## Decision

**Route.** `GET /v1/store/content/home`:

- is behind the age ticket like every store read;
- is limited per address with the catalogue budget;
- answers `private, no-store` with `Vary: Cookie`.

**One assembled response** (`storeHomeResponseSchema`):

| Field         | Content                                                      |
| ------------- | ------------------------------------------------------------ |
| `ticker`      | The messages, or null when the bar is off                    |
| `hero`        | Eyebrow, title, subtitle, button (`label`, `href`) and image |
| `featured`    | Product cards                                                |
| `bestSellers` | Product cards                                                |
| `brands`      | Name, slug and visible product count                         |
| `banners`     | Enabled banners only                                         |
| `offers`      | Title and product cards, or null when off                    |

A section that is unpublished or switched off is null or empty, and the page leaves it out. Cards and images are exactly the catalogue's own: the same card fields and the same short-lived signed links to sanitized derivatives.

**Only published copies** (`readPublishedHome` in `packages/db/src/store-content.ts`). Each published copy is parsed with the schema version that wrote it, and a row that does not parse is left out with a warning. Drafts are never read. Everything is read in one repeatable-read snapshot.

**Every reference is checked again at read time:**

- A product must be visible, by the same rule as the catalogue.
- A brand or category must be active and not trashed.
- An image must be a ready content image.

Anything else is left out. A button whose target is no longer visible is dropped, and the section keeps its text. Links are resolved from IDs to the current slugs (`/shop`, `/categories/<slug>`, `/brands/<slug>`, `/p/<slug>`), so a rename never breaks one. The contract only accepts those four shapes. No IDs, stock counts or order data reach the answer.

**Automatic best sellers** count units in non-cancelled orders of the last 30 days. They keep visible, in-stock products only, at most 8, and ties go to the newer product. Manual lists keep the Owner's order and keep out-of-stock products, as featured products do.

**Cache.** The response sits in the catalogue cache under `store:content:home`, for at most the cache TTL of 60 s. Both `content.published` and `catalog.changed` clear the cache (step 97), and the admin content controller drops the local copy after each write. So a product change and a publish both reach the home page within the cache's normal propagation.

## Alternatives considered

- **Trusting the publish-time check.** Rejected: the catalogue changes after publishing, and the publish check takes no locks.
- **One request per section.** Rejected: the architecture calls for one assembled response built from batched product reads, and seven requests would make seven cache entries.
- **Best sellers from the analytics roll-up.** Not available until step 106. The orders query is bounded (30 days, top 50) and cached.

## Consequences

- Step 99 renders this response on the home page. It needs no other content call.
- A hidden product disappears from the home page within the cache TTL even if no event reaches the cache.
