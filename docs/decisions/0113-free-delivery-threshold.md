# 0113 — Free delivery from a threshold

- Status: Accepted
- Date: 2026-11-12
- Decided by: Marina (client request)

## Context

At launch, delivery was one flat fee for every active UAE area, and free delivery was switched off: the delivery setting could only hold `freeThresholdFils: null`. This was enforced by the contract, the domain and a database CHECK. The storefront's free-delivery progress bar was built but stayed hidden. The client now wants orders of AED 400 or more to have free delivery, and the rest to pay AED 20.

## Decision

- **Setting:** the delivery setting's `freeThresholdFils` may be a positive integer amount of fils, or null to keep free delivery off. The Owner sets it under Admin → Settings → Delivery ("Free delivery from (AED)"; leave it empty to switch free delivery off). Migration `20261112000100_free_delivery_threshold` relaxes `settings_delivery_value` to allow it (expand-only).
- **Rule (domain `deliveryFeeFor`):** an order pays no delivery fee when its merchandise subtotal after any coupon discount reaches the threshold (`>=`); otherwise it pays the flat fee. The threshold counts what the shopper pays for the goods, so a coupon that takes an order below the threshold brings the fee back.
- **One place:** the quote's `assemble` prices the goods first, then prices the order with the fee that applies. Checkout, order creation, admin manual orders and controlled order edits all go through it. The fee is part of the quote fingerprint (ADR 0041), so a change between quote and order needs a new acceptance. Each order keeps its fee snapshot.
- **Display:** a zero fee reads "Free" in the cart, the confirmation, tracking, the order email and the admin. The cart shows the existing progress bar ("Add AED X more for free delivery"), and the Help page names the threshold. The product page no longer says "one flat delivery fee".

## Consequences

- Free delivery is configuration, not code: the Owner can change the threshold or switch it off at any time. Quotes already shown then need re-acceptance.
- Editing an order can move it across the threshold, and the edit then changes the fee accordingly.
- Production is set to a fee of AED 20 with free delivery from AED 400 once this release is live.
