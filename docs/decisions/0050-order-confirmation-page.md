# 0050 — Order confirmation page and what happens after success

- Date: 2026-10-13
- Status: accepted
- Step(s): 81 (correctness gate: 82)

## Context

Roadmap step 81: the confirmation page and cart handling on success. The cart clears only after an acknowledged order; the display is sanitized; no third-party analytics or session replay sees it. Architecture §7 "Confirmation transport". The API already sets `__Host-ih_order` and serves `GET /v1/store/order-confirmation` (ADR 0048); the checkout form already ends the attempt and empties the cart on a readable 201 (ADR 0049).

## Decision

**Page.** `/order-confirmation`, behind the routing gate. The server renders a frame and reads nothing from the address: no query or path value is used. The browser reads the order from the API with the HttpOnly cookie, so no order data passes through the storefront server or its HTML. The page sends no referrer, is marked `noindex`, and loads no script, frame or image from another origin.

**After a 201.** In this order: the attempt key is ended, the cart is emptied, the acknowledgement (number, total, time) is remembered in memory, and the browser goes to `/order-confirmation` with `router.replace`, so Back does not return to the form of a placed order. Nothing is added to the URL.

**What is shown** is the API's snapshot and nothing else: order number, time (UAE time), status line, total to pay in cash, what happens next, items with options, quantity and unit price, subtotal, discount, delivery, total, and the delivery address. No customer name, phone, Makani or delivery note: the API does not return them. Every amount is the API's; the subtotal row is `total − delivery + discount` from the same answer, and no price is multiplied or summed in the browser. The database guarantees that identity for every order (`order_total` check, ADR 0042). A snapshot that does not match the contract exactly is not shown.

**States.**

| API answer                        | Page                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 200                               | The order                                                                                                                                     |
| 401 (no cookie, unknown, expired) | "This order can't be shown here"; if the order was placed in this visit, its number and total from memory, and that the order is not affected |
| 429, 5xx, no answer               | "We couldn't load your order" with "Try again"                                                                                                |

**Nothing about the order is kept on the device.** The acknowledgement lives in module memory for the visit. The prototype's `lastOrder` storage is not used and stays in the legacy cleanup list.

**WhatsApp.** "Message us about this order" opens WhatsApp with the display order number in a message the shopper sends themselves; shown only when the Owner has configured a number. The order number grants nothing.

**"Already placed".** The checkout screen for a reused or old key now links to this page. It shows the order only if this browser still holds a valid cookie for it.

## Consequences

- After 30 minutes, on another device, or after a reload once the cookie is gone, the page cannot name the order. The shopper is told the order is unaffected and is pointed to WhatsApp when it is configured.
- The "what happens next" wording promises no time and is placeholder copy until the client approves it (BI-01, BI-09).
- The page shows the status at load; it does not update by itself.
- If the confirmation page cannot be opened after a 201 (connection dropped, or the age ticket ran out in that moment), the checkout page still shows the order number, the total and a link; the cart is already empty and the order is placed.
- The order of "key ended, cart emptied, then navigate" is shown by the browser pass (`scripts/browser-qa/checkout.mjs`), not by a unit test.
