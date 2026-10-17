# 0062 — Review submission through the staff-sent link

- Date: 2026-10-15
- Status: accepted
- Step(s): 94 (builds on ADR 0061; moderation and public aggregates: 95)

## Context

Roadmap step 94 adds the store side of verified reviews. Its done condition: rating, text, schema and rate limits; a proof grants no access to order data; abuse never publishes anything. ADR 0061 left three duties to this step: take the token from the request body only, redact it from logs, and give the store route its own rate limit.

The link carries its token in the URL fragment. Every shop page sits behind the age question. The question is a form post that redirects back, so without help the fragment would be lost on the way back.

## Decision

**Routes.** Both routes are behind the age ticket and the store Origin and JSON rules. They answer `private, no-store`, `Vary: Cookie` and `Referrer-Policy: no-referrer`.

- `POST /v1/store/reviews/proof` with `{ token }`. It returns `expiresAt` and the products left to review, by ID and catalogue name only.
- `POST /v1/store/reviews` with `{ token, productId, rating, title, body, authorName }`. It returns `{ status: "pending", remaining }`.

A link that proves nothing gets one answer from both routes: 409 `REVIEW_PROOF_INVALID`. That covers a link that is unknown, replaced or expired, an order that is not Delivered, a product the link does not cover, and a product already reviewed. A token that is not shaped like one (43 base64url characters) is refused as 400 by the contract.

**Rate limits.** The limits are per client address only: proof reads at 30 per minute, submissions at 10 per minute. Each has a bounded local fallback for when the shared limiter is down. A per-token key would let rotating tokens create unlimited limiter partitions, and a 256-bit token cannot be guessed anyway.

**Text.** The contract normalises text before it checks it:

- NFC.
- Title and name are collapsed to one line.
- The body keeps its line breaks, with at most one blank line in a row.
- Outer spaces are trimmed.

It then enforces these limits: rating is an integer from 1 to 5, title 1–120 characters, body 10–2000, name 1–60. It refuses control characters and invisible or direction-changing marks: U+200B, U+200E/F, U+202A–202E, U+2060–2069 and U+FEFF. ZWNJ and ZWJ are allowed, because Arabic and Persian names and emoji need them. Unknown fields such as `status`, `verified` or `orderId` are refused.

**Transaction.** `submitReview` does all of this in one transaction:

1. `lockReviewProof` locks the order, then the proof.
2. The review is inserted as pending, which the database also enforces.
3. An audit entry is written with actor system. It records the product, order, proof and rating, never the words or the name.
4. An IDs-only `review.submitted` event is written.

If a unique violation ever got past the order lock, it would map to the same `REVIEW_PROOF_INVALID`.

**Notification.** `review.submitted` gets the `notification` consumer. The inbox entry is "New review: <product>" with "<n> of 5 stars · waiting for moderation". It goes to active staff who hold `reviews.moderate` and `notifications.read_own`, so Owners only at launch, and only while the in-app inbox is on. There is no backfill: no review could be submitted before this step. The admin bell shows the `/reviews` link once step 95 adds that page.

**Logs.** `token` was already redacted. The redaction pattern now also covers `author`.

**Page.** `/review` is a shop page behind the routing gate, and its HTML holds no product data.

- In the browser it reads the token from the fragment once, validates it, and removes it from the address bar with `history.replaceState`. It keeps the token in component memory only, never in device storage, and sends it in POST bodies.
- A reload asks the customer to open the link from the message again.
- If the age ticket runs out mid-visit, the page goes to `/age-check?recheck=1&return=/review#<token>`.
- The age-check page appends its own fragment (at most 512 characters) to the accept form's action. The redirect after accepting has no fragment of its own, so the browser keeps that one, and the token returns to `/review` without reaching the server. This was checked in Chromium. Without script, the question still works, and the link is simply opened again.

## Alternatives considered

- **Make `/review` public, outside the age gate.** Rejected. Product names would then be readable by anyone who holds a link, without the age ticket.
- **Keep the token in sessionStorage across the age question.** Rejected. The page would persist a credential, and the fragment hand-over works without that.
- **Rate limit per token.** Rejected, for the partitioning reason above.

## Consequences

- Correction to ADR 0061: a Delivered order cannot be cancelled (`ORDER_NOT_CANCELLABLE`), so "a Delivered order cancelled afterwards as a return loses its link" cannot happen today. The Delivered check in the proof stays as defence.
- Reviews stay invisible until step 95 adds moderation and public aggregates.
- Storefront wording is placeholder until BI-09.
