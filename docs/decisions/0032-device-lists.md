# 0032 — Saved items, compare and recently viewed on the device

- Date: 2026-10-11
- Status: accepted
- Step(s): 63 (cart: 61–62, ADR 0030/0031; wishlist analytics `wishlist_daily`: 106)

## Context

Roadmap step 63: wishlist, compare and recently viewed as device state, with no account or customer profile and no checkout PII persistence. The prototype has a heart on cards and the product page, a "Saved items" page, a "Compare kits" page for up to three kits, and a "Recently viewed" rail.

## Decision

**What is stored.** One localStorage key, `ih_lists_v1`: three lists of product slugs.

| List      | Limit | Order                |
| --------- | ----- | -------------------- |
| `saved`   | 100   | Newest first         |
| `compare` | 3     | Order added          |
| `recent`  | 12    | Newest first, unique |

Only slugs matching the catalogue slug pattern are accepted. The schema is strict on read: any other shape, including an extra field, reads as empty lists. No name, price, image, timestamp or anything about the shopper is stored, and nothing is sent to the server about these lists except the slugs being displayed. Nothing uses sessionStorage.

**What is shown always comes from the API**, at the moment of display:

- `GET /v1/store/product-cards?slug=…` (up to 24; `@AgeVerified()`, `private, no-store`, 120 per minute per address, not cached) returns the cards in the order asked. A slug is matched as a visible product's current slug or, failing that, a former one; each item carries the slug that was asked for and the current card. A slug with no item is no longer available; hidden and unknown products are indistinguishable.
- The compare page loads each kit through the existing product route (up to three reads).

**Renames and removals.** When the API answers an old slug with the current one, all three lists are updated to the current slug, and a product reached through both its old and current slug is shown once. A product that is no longer available is reported ("1 saved item is no longer available.") and removed only when the shopper presses the button. Nothing is dropped silently.

**UI.**

- Heart on every product card and a "Save to saved items" button on the product page; `/wishlist` ("Saved items") with the prototype's copy; a "Saved" link in the header.
- "Compare with other kits" on kit pages only; `/compare` shows the kits side by side with price, battery, output, pod capacity, coil, charging, display and availability. In a row the single best value is highlighted (lowest price, largest battery, highest output) when at least two kits have a value and they differ. Fewer than two kits shows the prototype's explanation.
- "Recently viewed" rail (up to four) on the product page, excluding the product being viewed, and under an empty cart. Opening a product page records it.

The server renders only the page frames; the lists are read in the browser after hydration.

## Not built here

- "Add a kit" suggestions and "Add to cart" inside the comparison table.
- The prototype's rating row (demo data) and "Browse best sellers" (no sales ranking yet).
- A way to turn off recently viewed, or to clear the lists in one action.
- Wishlist analytics (step 106); no saved-item events are sent anywhere.

## Alternatives considered

- **Storing a display snapshot** like the cart does. Rejected: these lists are not about to be bought, so there is no reason to show anything the server has not just confirmed.
- **Product IDs instead of slugs.** Rejected: the store API does not expose product IDs; slugs plus rename following do the same job.
- **One key per list.** Rejected: one versioned value is simpler to validate and migrate.

## Consequences

- These features need the browser to reach the API through the gateway; if a read fails the page says so and the lists stay on the device.
- Lists do not follow the shopper to another device or browser, and clearing site data removes them. That is the intended "no account" behaviour.
- Recently viewed records every product page opened on the device; anyone using the same browser profile can see it. This should be mentioned in the privacy policy text (BI-04/legal).
