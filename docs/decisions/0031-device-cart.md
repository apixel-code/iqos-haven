# 0031 — Device cart, quantities and availability

- Date: 2026-10-11
- Status: accepted
- Step(s): 62 (cart store: 61, ADR 0030; quote: 65+; checkout and orders: later milestone)

## Context

Roadmap step 62: a device cart with quantity and availability UI, where variant IDs persist, the server quote stays authoritative later, and deleted or unavailable items are handled. Architecture §4: persisted prices and availability are previews; a server quote is required before checkout. Acceptance CAT-02: explain an unavailable item, never choose another flavour.

## Decision

**What is stored.** Unchanged from ADR 0030: `ih_cart_v1` holds variant ID, product slug, quantity and a display snapshot. No availability or status is stored; it is worked out each time the cart is shown.

**Refresh route.** `GET /v1/store/cart/lines?variant=…` (up to 50 IDs; `@AgeVerified()`, `private, no-store`, 120 per minute per address, not cached). It returns, for each active variant of a visible product, the product name and slug, brand, option text in the product's option order, current price in fils, previous price, an in-stock yes/no and a thumbnail link. A requested ID that is not returned is no longer offered; hidden, inactive and unknown variants are indistinguishable. No stock count or SKU is returned.

**Line states** (`cartView`, pure and unit-tested):

| State       | When                                 | In the cart                                                                                                                          |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| ok          | Returned and in stock                | Counted; price from the server; a note if the price changed since it was added                                                       |
| sold out    | Returned, no stock                   | Shown, flagged "Sold out. Remove it to continue, or check back later."; not counted; quantity locked                                 |
| unavailable | Not returned                         | Shown from the device snapshot, flagged "No longer available. Remove it to continue."; not counted; quantity locked; no product link |
| unconfirmed | No answer yet, or the refresh failed | Shown from the snapshot and counted, with a notice that prices and availability are confirmed at checkout                            |

What the server said about a variant keeps applying while that variant is in the cart: removing or adding another line, or a failed refresh afterwards, cannot make a sold-out or withdrawn line look buyable again. A flagged line stays until the shopper removes it. Nothing is removed, replaced or re-priced silently. The refresh runs when the set of variants changes, not on every quantity change.

**Totals.** The summary shows a subtotal of the buyable lines in integer fils and "Delivery: Calculated at checkout". It is labelled as a preview. No delivery fee, free-delivery progress bar or promo code box is shown: the fee and area come from the quote (step 70), the free threshold is off by default, and coupons arrive later.

**Checkout** is not built yet, so the button is disabled and says so. While any line is flagged the summary also says to remove it first; the same rule will gate the real checkout.

**UI:** `/cart` (gated; the server renders only the frame), a header link with the item count, quantity steppers (1–10), remove, an empty state, and a "View cart" link after adding on the product page.

## Not built here

- Quote, delivery fee, coupons, checkout and the WhatsApp order button.
- "Recently viewed" under an empty cart (step 63).
- A cart sheet/drawer; the prototype opens one on wide screens after adding.

## Alternatives considered

- **Storing availability on the device.** Rejected: it would be stale the moment it was written.
- **Removing unavailable lines automatically.** Rejected: the shopper would not know why the cart shrank, and CAT-02 asks for an explanation.
- **Refreshing through a storefront route handler.** Rejected: the storefront holds no commerce logic; the browser calls the API through the gateway, which checks the age ticket.
- **POST with a body of IDs.** Not needed: 50 UUIDs fit in a query string, and a GET needs no CSRF handling.

## Consequences

- The cart needs the gateway route to refresh. Without it (or during an outage) it still works from the snapshot and says the figures are unconfirmed.
- The subtotal is a preview and can differ from the quote (price changes, stock sold between refresh and checkout). The quote and order steps re-check everything against the database.
- A sold-out line can be bought again only after the shopper reloads or changes the cart once stock returns; there is no background polling.
