# 0063 — Review moderation and the public rating

- Date: 2026-10-15
- Status: accepted
- Step(s): 95 (builds on ADR 0061 and 0062)

## Context

Roadmap step 95 has this done condition: reviews are pending, approved or rejected; only approved reviews are public; the verified flag is derived on the server.

The admin prototype (`VIEWS.reviews`) offers approve, reject, "Hide (reject)" for an approved review, "Approve all", Undo and a hard delete. The storefront prototype shows a rating summary with distribution bars and a list of reviews on the product page, but no rating on product cards. Its numbers, demo reviews and "demo" labels are placeholders.

## Decision

**Admin routes.** Both need `reviews.moderate`, which only the Owner holds at launch.

- `GET /v1/admin/reviews` lists reviews newest first with a keyset on `(created_at, id)`. It filters by status, product and rating. It also returns the counts per status for the tabs, the average of approved reviews, and the products that have reviews. The order behind each review (ID and number) is included only for a moderator who also holds `orders.read`.
- `POST /v1/admin/reviews/:id/moderation` takes `{ decision: approve | reject, expectedVersion }`. In one transaction it:
  1. locks the actor, then the review;
  2. checks the version (`VERSION_CONFLICT`);
  3. refuses a decision that changes nothing (`INVALID_TRANSITION`);
  4. sets the status, moderator, time and version;
  5. writes an audit entry (`review.approved` or `review.rejected`, status and version only);
  6. writes `catalog.changed` for the product.

  The route is limited per actor and address like the other admin commands.

An approved review can be hidden by rejecting it, and a rejected one can be approved later. A review never goes back to pending, and its content never changes; the database already enforces both (ADR 0061).

**Not built:**

- Hard delete: reviews are records, and the runtime role cannot delete them.
- "Approve all": every review should be read before it is published.
- Undo: rejecting after approving, or approving after rejecting, already does that job.

**Public side.** The product response gains two fields, both from approved reviews only:

- `rating`: the average to one decimal, the count, and the counts for 5 to 1 stars. It is null while no review is approved.
- `reviews`: the ten newest, each with rating, title, body, author name, the Dubai date and `verified`.

`verified` comes from the stored proof (`proof_id IS NOT NULL`) and is never taken from a client. Order, customer and review IDs are never included. The product page stays behind the age ticket like the rest of the product data. Product cards show no rating, as in the prototype.

**Cache.** The product page is in the catalogue cache.

- The admin reviews controller carries `CatalogueInvalidationInterceptor`, so the local cache drops after each decision commits.
- The `catalog.changed` event lets the existing `storefront_revalidate` consumer clear every other replica.
- `CATALOGUE_CACHE_VERSION` goes to 2 because the shape of the product response changed.

**Admin UI.** A Reviews section under Commerce has tabs with counts, product and rating filters, and an Approve and Reject (or "Hide (reject)") button on each review. Every decision is sent with the version shown on screen, and the list is reloaded afterwards. The notification bell links new-review notifications to it.

## Alternatives considered

- **A separate `review.moderated` event with its own consumer.** Not chosen. What changes in public is the product's page, which is what `catalog.changed` already invalidates.
- **Ratings on product cards.** Not in the prototype. Adding them would put a review query into every listing, search and saved-items read.

## Consequences

- Step 102 (acceptance) should cover moderation conflicts, cache invalidation across replicas, and proof abuse end to end.
- Storefront copy ("Verified purchase", the empty state) is placeholder wording until BI-09.
