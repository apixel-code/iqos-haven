# 0082 — Storefront cart sheet after adding

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-S1 (follows ADRs 0031, 0033 and 0041)

## Context

After "Add to cart" the store only showed an inline "Added" message and a "View cart" link. On a phone this is the main purchase path, and the shopper could not see what was in the cart without leaving the product. The prototype (`cartSheet`, `addToCart`) shows the cart's lines, quantity controls, totals and the way on. ADRs 0031 and 0033 had deferred the sheet. Marina chose G-S1 as the third tier-L parity gap to build before step 120 (2026-10-17).

## Decision

- **Behaviour:** after a successful add (not when the cart is full), one `CartSheet` in the store shell opens. On a phone it is a full-width bottom sheet; from 640px it is a full-height side panel. It is a native modal `<dialog>`, so focus moves in and the page behind is inert. Escape, the close button, "Continue shopping" or a click outside closes it. Quick add closes its own dialog and hands over to the sheet.
- **Contents:** the lines with the API's current price and availability (`useFreshCart`, the same as the cart page), quantity and remove controls, and the subtotal of buyable lines. Sold-out or withdrawn lines are flagged. There is a "View cart and checkout" link, "Continue shopping", and "Order on WhatsApp" when a number is set.
- **No payable total in the sheet.** Delivery, discount and the total come from the server quote, which the shopper accepts on the cart page (ADR 0041), and checkout needs that accepted quote. The sheet therefore leads to the cart page, not straight to checkout, and says that delivery and any discount are added there.
- **Shared code:** the line list is now `CartLines`, shared by the cart page and the sheet, so both show the same states. `openCartSheet`/`closeCartSheet` are a tiny module store with no device storage.

## Consequences

- The shopper sees the cart at once on every page, and nothing new is stored on the device.
- One extra step compared with the prototype ("Checkout" in the sheet): the cart page is where the area is chosen and the total accepted. That keeps the quote rule intact.
- Two browser-pass expectations in `checkout.mjs` that predated steps 104 and 107 were brought up to date: the anonymous telemetry ID and the `analytics_rollup` consumer.
