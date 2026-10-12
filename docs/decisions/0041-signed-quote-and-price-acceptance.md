# 0041 — Signed quote, its fingerprint, and explicit acceptance of a changed total

- Date: 2026-10-12
- Status: accepted
- Step(s): 71 (quote assembly: 70, ADR 0040; order transaction that checks the token: 75–76; checkout form: 77)

## Context

Roadmap step 71: a signed server quote API and client price acceptance; quote fingerprint and expiry; a changed price or configuration requires explicit new acceptance. Architecture §6: return a short-lived signed quote with fingerprint and expiry; submission recomputes it inside the transaction; if prices, eligibility or totals changed, answer `409 QUOTE_CHANGED` and require acceptance of the new quote; never silently charge a different total.

## Decision

**Route.** `POST /v1/store/cart/quote` (`CartQuoteController`), behind the age ticket, `private, no-store`, 30 requests a minute per address. It is a POST because it carries a cart; it reserves no stock, uses no coupon and records nothing. As a store POST it must come from an allowed storefront Origin. The body is lines (variant ID, quantity), an area ID and at most one coupon code; a price, fee, discount, total or second code is a 400.

**Answer.** Lines with unit price, subtotal, discount share and total; merchandise subtotal, discount, delivery fee, total; the area name, emirate and ETA; the coupon code and percentage; `insufficientStock` (variant IDs only); and `quote: { token, fingerprint, expiresAt }`. No stock number, version, SKU or internal reference.

**Failures** are one stable 409 code each and nothing more: `AREA_UNAVAILABLE` (closed, unknown, or delivery not configured), `VARIANT_UNAVAILABLE`, `COUPON_INVALID`, `COUPON_LIMIT_REACHED`. An inactive code is indistinguishable from one that does not exist.

**Fingerprint (`quoteFingerprint`, `@ih/platform`).** SHA-256 over a canonical array of exactly what the shopper is charged for: area ID, delivery fee, coupon code and percentage, merchandise subtotal, discount, total, and each line's variant ID, quantity and unit price (lines sorted). It changes when any of those changes, in either direction. It does not include versions, the area name or the ETA text: a description edit or a reworded ETA does not force a new acceptance, while any change of money, quantity, area or coupon does.

**Token (`signQuote` / `verifyQuote`).** `v1.<keyId>.<expiry>.<fingerprint>.<HMAC-SHA256>`, with a purpose-specific key (`QUOTE_SIGNING_KEYS`, entries `quote:<keyId>:<secret>`; the first signs, all verify, so keys can be rotated) and a lifetime of `QUOTE_TTL_SECONDS` (default 900). The key ID and expiry are inside the MAC. The token is not a credential and carries no price the server later trusts: it only says "the server showed this total at this time".

**At order time (`checkAcceptedQuote`, used from step 76).** The server recomputes the quote under its locks (`lockQuoteForOrder`) and compares fingerprints: `ACCEPTED`, `QUOTE_EXPIRED`, or `QUOTE_CHANGED`. A forged, malformed or unknown-key token is treated as `QUOTE_CHANGED`: the shopper is shown the current total and must accept it. A lower price is still a change.

**Keys by environment.** Staging and production refuse to start without `QUOTE_SIGNING_KEYS`; every API replica must share the same ring. In development and test an empty ring makes the API sign with a key created at start-up, so quotes do not survive a restart (the shopper is simply quoted again).

**On the cart page (`CartQuote`).** The shopper chooses a delivery area (from `GET /v1/store/delivery`, grouped by emirate) and may apply one code; the page shows the server's discount, delivery fee and total. The device cart's own prices remain a preview. Rules, kept in a small tested module (`lib/cart/quote.ts`):

- A total that answers the shopper's own change (cart, area, code) is shown and counts as seen.
- A different total for the same request, or after the server refused a code the shopper had an accepted total with, is announced with both amounts and needs "Accept new total".
- A refused code is dropped and the cart is priced without it ("continue without the code"), with a message.
- Lines that cannot be filled are named; the total is then not confirmed.
- The token is refreshed when it expires.
- The area, code, total and token live in memory only; nothing is written to browser storage.

## Not built here

- Placing an order, and therefore the server-side use of `checkAcceptedQuote` (step 76); the checkout form with name, phone and address (step 77). The Checkout button stays disabled.
- A stricter limit for failed coupon attempts than the route's 30 a minute per address.

## Alternatives considered

- **Fingerprint including versions.** Rejected: unrelated edits would force re-acceptance.
- **No signature, fingerprint only.** Considered: the order recomputes anyway. Kept the signature because it proves the total was issued by the server and bounds how old an acceptance can be, as the architecture asks.
- **Returning unavailable lines inside a 200.** Rejected: the cart page already refreshes line availability; one failure code keeps the contract simple.

## Consequences

- `COUPON_INVALID` versus `COUPON_LIMIT_REACHED` reveals that a full code exists (accepted by the architecture). Codes should not be guessable; the rate limit only slows guessing.
- A changed ETA text alone never asks the shopper to accept again.
