# 0061 — Reviews and verified-purchase proof by staff-sent link

- Date: 2026-10-15
- Status: accepted
- Step(s): 93 (submission: 94; moderation and public aggregates: 95)

## Context

Roadmap step 93 introduces the review schema and the issuance and validation of the verified-purchase proof. Its done condition: only an eligible delivered order and product qualify; the proof is bounded and expires; a supplied order ID alone is insufficient.

Architecture §10 describes the proof as an opaque, expiring token linked to an eligible delivered order and purchased product, stored as a hash. Unverified submissions are allowed only if the client explicitly allows them.

The store has guest checkout and no customer accounts. Its only customer channel is the phone or WhatsApp (ADR 0058). Marina's answers on 2026-10-15 (BI-12): staff send the link by WhatsApp, and only verified reviews are accepted.

## Decision

**Issuance: staff command.** `POST /v1/admin/orders/:id/review-link` requires `orders.read` and `customers.read`, the same rights as the WhatsApp messages, because the link goes to the customer's phone. It is also limited by the admin origin and a per-actor and per-address rate limit. The command is refused in these cases, before anything is written:

- The order is not Delivered: 409 `REVIEW_NOT_ALLOWED`.
- Every product of the order already has a review: 409 `NOTHING_TO_REVIEW`.
- The store domain is missing from Settings: 409 `STORE_DOMAIN_REQUIRED`.

In one transaction the command:

1. Locks the actor, then the order.
2. Revokes the order's previous link.
3. Stores the SHA-256 of a new 256-bit token, with a 30-day expiry.
4. Writes an audit entry, which never contains the token.

The answer, sent with `no-store`, carries the link `https://<store domain>/review#<token>` and a ready `wa.me` message that uses placeholder wording until BI-09. The token sits in the fragment, so it never reaches a server log or a Referer header. It is shown once and cannot be fetched again: a lost link means creating a new one. Nothing is sent or recorded as sent.

**What a proof grants.** `readReviewProof(token)` returns the products left to review, as ID and catalogue name only, with no order number, customer, address or total. The products left to review are those of the order that are in the catalogue and not yet reviewed for that order. `lockReviewProof(tx, token, productId)` is what step 94's submission transaction calls. It locks the live proof row and confirms that the product is one of these products.

A proof stops working when it is revoked, when it expires, or when its order stops being Delivered. Every failure, including a well-formed guess or an order ID, gives one code, `REVIEW_PROOF_INVALID`, so nothing can be probed.

**Schema (migration `20261015000300_reviews`).**

- **`review_proofs`:** a unique 32-byte hash and at most one live (unrevoked) proof per order. Only `revoked_at` may change, and only once. No delete.
- **`reviews`:** product, order and proof are all required, so every review is verified and the verified flag is derived, never supplied. The table also holds the rating (1–5), title (≤120), body (≤2000), author name (≤60), status, moderator and time, and a version. A trigger enforces the rest:
  - A review starts pending.
  - Its proof must belong to its order, and its product must be in that order.
  - One review per order and product (unique constraint).
  - The content never changes; only moderation fields and the version do.
  - No delete. The runtime role cannot delete or truncate either table.

The roadmap's table rollout lists only `reviews` for step 93; `review_proofs` is added with it because the proof needs durable state.

## Alternatives considered

- **Issue automatically on delivery.** Rejected for now: the raw token would have to be kept encrypted so that staff could see it later, and nothing would send it anyway.
- **Proof from the confirmation cookie.** Rejected: the cookie lasts 30 minutes, long before delivery.
- **Signed stateless claim.** Rejected: a stored hash can be revoked when a new link is made, and it needs no new key.
- **Unverified reviews with no badge.** Not accepted (BI-12). Allowing them later means making `proof_id` and `order_id` nullable and adding stronger abuse limits.

## Consequences

- Reviews exist only for orders staff choose to ask. The link wording is placeholder until BI-09.
- A product removed from the catalogue cannot be reviewed through an older link.
- A Delivered order cancelled afterwards as a return loses its link at once.
- `lockReviewProof` locks the order before the proof, so a cancellation and a submission take turns; the second sees the result of the first.
- Step 94 must take the token from the request body only, add it to the log redaction paths and give the store route its own rate limit.
- Step 94 adds the public `/review` page, which reads the fragment and posts it in the body, never in the URL. It also adds the store route, with rate limits, for submitting a review through `lockReviewProof`.
- Step 95 adds moderation with expected versions, and public aggregates from approved reviews only.
