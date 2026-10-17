# 0067 — Offers page, Help page and the free-delivery rule

- Date: 2026-10-15
- Status: accepted
- Step(s): 100

## Context

Roadmap step 100 has this done condition: unsupported demo coupons are removed, and the free-delivery progress stays hidden while free delivery is disabled. The prototype's demo copy works against both:

- **Coupon codes:** the HAVEN10 hints in the cart, the ticker and the campaign; a Copy-code banner on the Offers page.
- **Free delivery:** "AED 15, free over AED 150" in Help and on the product page, and a progress bar that is only hidden because its threshold is null.
- **Dubai-only wording:** delivery is described as Dubai-only throughout.
- **Placeholder contact details:** a demo WhatsApp number, hours and email.

## Decision

- **Offers (`/offers`):** a normal product listing with a fixed `sale=1` filter. The store products API gains `sale`, meaning a compare-at price above the lowest current price, the same rule as a card's "was" price. `sale` is part of the cache key. No coupon codes are shown (BI-13). The page is linked from the header, the footer and the home Offers section.
- **Help (`/help`):**
  - Delivery facts come from the Owner's settings through the API: the fee, the delivery time and the emirates actually served. A zero fee reads "Included in your total", not "Free".
  - Cash on delivery is described as it works.
  - The FAQ does not claim a returns policy; it says the policy will be published and offers WhatsApp until then.
  - The contact section shows only the configured WhatsApp number.
  - The policy pages are linked.
- **Free-delivery progress:** a cart component words the server quote's amounts. It renders only for a numeric threshold, and the contract keeps `freeThresholdFils`/`freeDeliveryThresholdFils` as `null`, so nothing shows or is claimed at launch. When a reviewed policy enables a threshold, the API should also send the remaining amount with the quote.
- **Guard:** `scripts/check-reference-set.mjs`, part of verify, fails if application code under `apps/` or `packages/` (tests excluded) contains a demo code (HAVEN10, SAVE20, VEKTOR15, BIGBOX15) or a fixed free-delivery phrase. It is a tripwire, not proof. The age preview also asserts that the home, Offers and Help pages carry no free-delivery claim or demo code.

## Consequences

- Wording on Help (hours, email, returns) waits for BI-01 and BI-09.
- `SITE.description` ("Adults-only store in Dubai") is the generic preview text and was left unchanged. It needs the client's approved wording (BI-01/BI-05).
