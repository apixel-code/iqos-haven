# 0042 — Orders, order lines and status history

- Date: 2026-10-12
- Status: accepted
- Step(s): 73 (idempotency: 74; lock helpers: 75; order creation: 76; confirmation: 79; edits: 85; cancel: 86; collection: 88)

## Context

Roadmap step 73: `orders`, `order_items`, `order_status_history`; immutable customer, item, price and address snapshots; six states; a unique order number. Architecture §5–§7: orders keep their own snapshots; orders are never deleted; every transition has an append-only history row; Delivered never implies cash collected; the order keeps a hash of its creation key and of its confirmation capability. There is no tax (ADR 0036).

This step is the schema. Nothing creates an order yet (step 76).

## Decision

**An order carries its own copy** of the customer name and phone, the area (ID, code, name, emirate), the address, the coupon code and percentage, the delivery fee and ETA, the totals, the accepted quote fingerprint and the 18+ confirmation. Each line carries the product name and slug, brand, category, SKU, option values, product and variant versions, unit price, quantity and its share of the discount. Later edits of customers, products, variants, coupons or delivery settings do not reach an order, and nothing an order points at can be deleted (RESTRICT foreign keys).

**Order number.** A database identity starting at 1001, shown as `IH-001001` (`formatOrderNumber`, `parseOrderNumber`). It cannot be chosen or changed. Gaps are normal. It identifies an order to people and authorizes nothing.

**What the database itself guarantees** (checks and triggers, for every writer):

| Rule                                                                                                                           | How                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Total = merchandise − discount + delivery; a discount needs a coupon; amounts bounded                                          | Table checks                                                                            |
| An order has lines, and its subtotal and discount are the sums of its lines                                                    | Checked at commit                                                                       |
| The status is always the last history row                                                                                      | Checked at commit                                                                       |
| Only the eight transitions of the state machine                                                                                | `order_transition_allowed`, used by the order trigger and the history check; never NULL |
| History starts at creation: pending, or confirmed only for a staff-entered order, at version 1                                 | History trigger                                                                         |
| History continues from the last status; a status is left once                                                                  | History trigger and a unique index                                                      |
| History is append-only; one row per command per order                                                                          | Trigger and unique `(order_id, command_id)`                                             |
| A cancellation has a reason, and cash becomes `not_collected`                                                                  | Checks                                                                                  |
| Cash is recorded only for a delivered order, with amount, time and person                                                      | Checks                                                                                  |
| A dispatch, delivery, cancellation, return or cash record is written once                                                      | Order trigger                                                                           |
| Customer, address, area, coupon, fee and totals change only while Pending or Confirmed, and not in the update that moves it on | Order trigger                                                                           |
| Lines change only while the order is Pending or Confirmed                                                                      | Line trigger                                                                            |
| Every change advances the version by exactly one                                                                               | Order trigger                                                                           |
| Identity (number, customer, source, creator, creation key, age confirmation) never changes                                     | Order trigger                                                                           |
| An order is never deleted, by anyone                                                                                           | Trigger; the runtime role also has no DELETE                                            |
| One order per creation key                                                                                                     | Unique `(creation_scope, creation_key_hash)`                                            |

The commit-time checks let an order, its lines and its history be written in any sequence inside one transaction, but never committed disagreeing.

**Secrets.** Only SHA-256 hashes of the idempotency key, the request payload and the confirmation capability are stored.

**Coupons.** `coupon_redemptions.order_id` now references `orders` (ADR 0038 left this for here).

**Runtime role:** no DELETE or TRUNCATE on the three tables, no UPDATE on history. Order lines cannot be deleted at runtime either; whether an edit may remove a line is decided with order edits (step 85).

## Not built here

- Creating, editing, cancelling or collecting an order (steps 76, 85, 86, 88); the idempotency table (74).
- Stock movement reasons and references for orders (step 76).
- A table for corrections of a cash record (step 88): the original record cannot be overwritten, so a correction will be a new record.
- Retention and anonymization of the personal fields on old orders (BI-08 defaults, M11).

## Alternatives considered

- **Order number as text generated in the application.** Rejected: the database is the only place that can make it unique without a race.
- **Enforcing the state machine only in the domain.** Kept in both: the domain decides, the database refuses anything else from any writer.
- **Locking the order row inside the history trigger.** Rejected: it would take the order lock late, against the lock order. The caller holds the order lock; the unique index is the lock-free backstop.
- **`collected_amount_fils` must equal the total.** Not enforced: a short or over payment must be recordable. Step 88 decides the rule.

## Consequences

- A command that changes an order must write the history row and bump the version in the same transaction, or its commit fails.
- Tests that need an order use the `seedOrder` fixture (`@ih/db/testing`).
