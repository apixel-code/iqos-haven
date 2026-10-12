# 0040 — Quote assembly: one flat delivery fee and the references a quote carries

- Date: 2026-10-12
- Status: accepted
- Step(s): 70 (pricing: 67, ADR 0037; coupons: 68, ADR 0038; signed quote API: 71; order transaction: 75–76)

## Context

Roadmap step 70: delivery fee calculation and quote assembly; flat fee; the free threshold stays off unless approved; tax/config references captured. There is no tax (ADR 0036), so the references are the versions of the configuration the quote was built from. Architecture §6: one configured flat fee for an active approved area; the area and fee are snapshotted on the order; a quote carries price/config versions.

## Decision

**One function builds every quote (`assemble`, `@ih/db` `quote.ts`)**, reached two ways:

- `previewQuote(db, input)` — no locks, for showing a price.
- `lockQuoteForOrder(tx, input)` — inside the order transaction, taking the settings/area, catalogue and coupon groups of the resource order in that order and holding them until commit.

Because both go through the same assembly, an order that finds nothing changed computes exactly the numbers the shopper was shown.

**Input** is variant IDs with quantities, an area ID and at most one typed coupon code. Nothing else is read from the caller: no price, fee, discount or subtotal.

**Steps, in this order (also the order failures are reported in):**

1. Delivery: the area must exist, be active and be in one of the emirates (`DeliveryUnavailableError`), and the Owner must have configured the fee and ETA (`DeliveryUnconfiguredError`).
2. Lines: merged and capped, then the current price of each variant a shopper may see (`VariantUnavailableError`, `OrderLinesError`).
3. Coupon, if a code was typed: judged on the merchandise subtotal before the discount (`CouponRejectedError`). Delivery never counts toward a minimum.
4. Totals: `priceOrder` (ADR 0037). Delivery is added after the discount and is never discounted.

**Delivery fee.** The single configured flat fee, the same for every active area in every emirate and for every order value. Free delivery is off: the configuration cannot hold a threshold (contract and database check), and every quote carries `freeDeliveryThresholdFils: null`.

**References a quote carries:** per line the product ID, product version and variant version; the area ID, code, name, emirate and version; the delivery configuration version; the coupon ID, code, percentage and version. Step 71 turns these into the fingerprint.

**Stock.** A preview reserves nothing. It names, in `insufficientStock`, the lines that could not be filled at that moment, as variant IDs only (never a stock number). The order transaction decides stock itself under the variant locks.

**Store route for the checkout form:** `GET /v1/store/delivery` (age-verified, `private, no-store`, rate limited like other store reads, not cached) returns the active areas (ID, name, emirate), the flat fee and the ETA text; fee and ETA are null until the Owner configures delivery.

## Not built here

- The quote route, its signed fingerprint and expiry, and the storefront's price display (step 71).
- Consuming stock, creating the order, redeeming the coupon (steps 75–76).
- Per-area or per-emirate fees; a free-delivery threshold.

## Alternatives considered

- **Separate preview and order calculations.** Rejected: two code paths would drift, and a drift is a wrong charge.
- **Pricing a cart with an unavailable line by dropping the line.** Rejected: the shopper must see and decide (ADR 0031).
- **Caching the delivery choices.** Rejected: the list is small and an area switched off should disappear at once.

## Consequences

- A cart cannot be quoted until the Owner has entered a fee and ETA and activated at least one area.
- A quote with a coupon fails entirely when the coupon is not usable; the storefront must offer "continue without the code".
