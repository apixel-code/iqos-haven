# 0053 — Versioned order edits and diff history

- Date: 2026-10-13
- Status: accepted
- Step(s): 85

## Context

Staff must correct an order before fulfilment without replacing its identity, corrupting stock or coupon counts, or hiding what changed. Pending and Confirmed orders may change merchandise, coupon and delivery address. Once Processing starts, merchandise and delivery facts are fixed, but staff still need a bounded operational note. Retries and concurrent operators must have deterministic outcomes.

## Decision

`PATCH /v1/admin/orders/:id` requires `orders.edit`, a valid admin Origin and a fail-closed per-address/per-actor limit. Its strict command contains `expectedVersion`, a globally unique UUID `commandId`, and at least one of lines, coupon code, delivery address or operational note. Pending and Confirmed accept every edit field. Processing accepts only the operational note. Other states reject edits. Item removal is allowed when at least one line remains.

The transaction rechecks the actor, claims the permanent command through `order_edit_history`, locks the order, checks its version, and follows the existing customer → delivery → catalogue → coupon → variant lock order. It validates every target product against current saleability. Lines whose quantity did not change retain their sold price and catalogue snapshot; changed and new lines use current locked catalogue facts. Coupon eligibility, line discount allocation, delivery charge and total are recalculated together.

Only net item quantity changes reach the append-only stock ledger with reason `ORDER_EDIT`: increases/new lines consume stock and decreases/removed lines release it. Every movement calls the low-stock crossing publisher in the same transaction. Coupon replacement first releases the active redemption, locks old and new coupon rows in sorted ID order, evaluates the new use under those locks, and leaves every released redemption as history. A partial unique index permits only one active redemption per order.

Every accepted edit increments the order version once and appends one immutable, display-safe diff containing SKU/quantity, coupon code, area/address-change marker, operational note and total changes as applicable. It also writes metadata-only audit and an IDs-only `order.updated` event. A deferred trigger verifies that the inserted edit version equals the committed order version. A no-op is `NO_CHANGES` and rolls back every tentative coupon, stock or address effect.

The command ID and normalized payload hash make retries permanent: the same actor/order/payload returns the original receipt with `replayed: true`; reuse with another actor, order or payload is `COMMAND_REUSED`. `expectedVersion` conflicts are `VERSION_CONFLICT`. The admin detail exposes variant and area IDs only to staff with `orders.edit`, reloads after committed responses, and displays the append-only diff timeline. Customer address fields still require `customers.read`.

## Consequences

- Item, coupon, address, totals, stock movements, redemption history, edit history, audit and event commit together or all roll back.
- Processing notes advance the order version and appear in the same diff history; they do not rewrite the order snapshot.
- Removing the final line remains invalid because an order must contain at least one item.
- The UI can add an item when an operator supplies its variant identifier; a searchable order-item picker can replace that input later without changing this command contract.
- Cancellation and return stock effects remain step 86.
