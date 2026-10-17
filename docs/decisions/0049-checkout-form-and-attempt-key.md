# 0049 — Checkout form and the attempt key on the device

- Date: 2026-10-13
- Status: accepted
- Step(s): 80 (confirmation page and its navigation: 81; correctness gate: 82)

## Context

Roadmap step 80: the checkout form. Name, phone and address stay in memory only; the attempt key survives a refresh; the second 18+ confirmation is required; an uncertain answer is retried, never re-ordered. Architecture §7 steps 1–2 and 7. The order route (ADR 0046) and the confirmation cookie (ADR 0048) exist.

## Decision

**Page.** `/checkout` behind the routing gate. The server renders the frame and one fact, whether orders are being taken. The cart, the form and the total are drawn in the browser, which posts to the API through the gateway; nothing typed reaches the storefront server. The page sends no referrer.

**One switch.** `GET /v1/store/info` gains `checkoutOpen`, which is the API's `CHECKOUT_SUBMISSION_ENABLED`. The cart page links to checkout only when it is true and the shopper holds an accepted total; `/checkout` says "Checkout is not open yet" otherwise. The order route still decides on every order.

**What is kept where.**

- React state only: name, phone, address type, building, unit, street, Makani, notes, the 18+ tick.
- Module memory, gone on reload: the chosen delivery area and discount code (`lib/checkout/memory.ts`), so they carry from the cart page to checkout.
- Device storage: `ih_checkout_attempt_v1` = `{ key, createdAt }` and nothing else. The key is 256 random bits, made at the first press of "Place order".

**The attempt key ends in exactly two ways:** the API acknowledges the order (201 with a readable answer), or the shopper presses "Place a second order" after being told an order already exists. Every other answer keeps it.

| Answer                                                                      | Shopper sees                                                       | Key                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| 201                                                                         | "Order placed" with number and total; cart emptied                 | ended                             |
| 400                                                                         | Field messages from the shared schemas (the API names fields only) | kept                              |
| 409 `QUOTE_CHANGED` / `QUOTE_EXPIRED` / coupon codes / `INSUFFICIENT_STOCK` | Total asked again; a changed total must be accepted                | kept                              |
| 409 `AREA_UNAVAILABLE` / `VARIANT_UNAVAILABLE`, 403                         | What to change, or reload                                          | kept                              |
| 409 `IDEMPOTENCY_IN_PROGRESS`, 429, 5xx, unreadable answer, no answer       | "Press again. Pressing again will not order twice."                | kept                              |
| 409 `IDEMPOTENCY_CONFLICT` / `CHECKOUT_RECOVERY_REQUIRED`                   | "This order was already placed"; never sent as new                 | kept until "Place a second order" |

After a refresh the form is empty. Typing the same details again and pressing the button replays the first order; typing different details gives "already placed", because an order with this key exists.

**Validation.** `validateForm` runs `checkoutContactSchema` and `checkoutAddressSchema` (ADR 0035) and adds the 18+ tick; all messages show at once with a linked summary. The request sends the lines, area, code and token of the accepted quote exactly as priced, and `ageConfirmed: true`.

**Success, for now.** The order number and total are shown in place. Step 81 replaces this with the confirmation page; the cookie that page needs is already set by the API.

**Not taken from the prototype:** saving the form to storage, the "+971 plus whatever was typed" display, demo promo codes, the disabled card-payment option, the fake order number and delays, the "process TBC" line.

## Consequences

- A shopper who reloads must type their details again. That is the price of keeping them off the device.
- A key is never rotated by age. An old key whose order was placed keeps answering "already placed" until the shopper starts a new order.
- If local storage is refused the key goes to session storage, which still survives a reload. If both are refused it lives for the page only: a retry on the page is safe, a reload after a lost answer is not protected.
- "Already placed" does not show the order number and does not empty the cart; the shopper is told nothing more is needed and that continuing makes a second order. Showing that order through the confirmation cookie belongs to step 81.
- A refused `Idempotency-Key` (damaged storage) replaces the key: nothing can have been placed with a key the API never accepted.
- The storefront needs no new setting; opening checkout is the API's switch alone.
