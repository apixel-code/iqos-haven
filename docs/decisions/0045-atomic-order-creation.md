# 0045 — Atomic order creation

- Date: 2026-10-13
- Status: accepted
- Step(s): 76 (store route and limiter: 77; notifications: 78; confirmation: 79; checkout form: 80)

## Context

Roadmap step 76: an order-creation service in which stock, coupon, order, snapshots, history, the response and the required outbox records commit together. Architecture §7 steps 4–7. The pieces exist: the idempotency ledger (ADR 0043), the lock walk (ADR 0044), the quote and its acceptance token (ADR 0040, 0041), the order schema (ADR 0042), coupons (ADR 0038) and the stock ledger (ADR 0017).

## Decision

**`createStoreOrder` (`@ih/db`) is one transaction.** In order:

1. Claim the idempotency key (`store.checkout` scope). A replay returns the stored answer here and does nothing else.
2. Look up `orders` by the same scope and key hash. An order already made with this key means the ledger answer was cleaned up: `CHECKOUT_RECOVERY_REQUIRED`, never a second order.
3. `lockForOrderCreation`: the customer (found or created by phone), the delivery settings and area, brands/categories/products, the coupon, the variants.
4. The total the shopper accepted is compared with the facts just read under those locks. Anything else is `QUOTE_CHANGED` or `QUOTE_EXPIRED`.
5. Stock is decided under the variant locks: an inactive variant or a line larger than the balance refuses the whole order (`INSUFFICIENT_STOCK`, naming the short lines).
6. Writes: the order with its snapshots; one line per variant; the first history row (`pending`, by the customer); one `SALE` stock movement per line through the ledger, with a low-stock event when a line crosses its threshold; the coupon redemption; the saved address; the customer's first-order time; one audit entry; one `order.created` event; the idempotency answer.

Any failure at any point rolls all of it back, including the claim, so the same key can be retried. No network call happens inside.

**Money has one source.** Order totals, line amounts and the coupon redemption all come from the single quote computed under the locks. The database then checks that the total is its parts and the order is the sum of its lines (ADR 0042).

**Stock sold by an order (migration `20261012000700_order_stock_movements`).** `stock_movements` gains `order_id` and the reason `SALE`. The database ties them together: a sale has an order, removes stock, uses the `sale` effect and the command ID `order:<id>`; nothing else may point at an order; with the existing unique key an order sells a variant once.

**The quote token.** The API service (`CreateOrderService`) verifies the token's signature before any database work: a token this server did not issue gets no claim and no lock. A genuine but expired token goes on, so a retry of an already-placed order still gets its answer; a new order with it is refused inside as `QUOTE_EXPIRED`. The fingerprint the token names is part of the request's identity and is stored on the order.

**What makes two requests the same order:** contact, address, merged lines, coupon code, the quote fingerprint and the age policy version. The request ID is not part of it.

**The answer** given and replayed: the order number, the total and the time. Nothing personal, and nothing that goes stale.

**Snapshots.** The customer name and phone are taken from the locked customer row. Product, brand, category, SKU and option values are read after the locks that freeze them. If a variant's version differs from the one it was priced at, the transaction starts again.

**Audit.** A guest order is recorded with the `system` actor (the audit model has no customer actor); the order's own history says `customer`. The entry holds what was ordered and charged, never who or where.

## Not built here

- The store route, its contract (including the second 18+ confirmation, which must be required there), rate limits and error mapping (step 77). No route calls this yet.
- New-order notifications (step 78); the confirmation capability and cookie (step 79); the checkout form (step 80).
- Staff-entered orders; releasing stock on cancellation (step 86).
- The scheduled cleanup of expired idempotency answers.

## Alternatives considered

- **Reserving stock at quote time.** Rejected by the roadmap: stock is taken only by an order.
- **A conditional `UPDATE variants … WHERE stock >= qty` outside the ledger.** Rejected: stock changes only through `stock_movements`; the variant row is already locked, so the check is a plain comparison.
- **Verifying the token only inside the transaction.** Rejected: a forged token would make the server take locks, including on a customer row chosen by the caller.

## Consequences

- An order with one unfillable line is refused whole; the shopper adjusts the cart and gets a new total.
- A shopper can be told `QUOTE_EXPIRED` for a correct total that is simply old; the storefront requotes and asks again.
- Step 77 must not return the order ID carried by `CHECKOUT_RECOVERY_REQUIRED`, and must map variant IDs in errors to the contract.
