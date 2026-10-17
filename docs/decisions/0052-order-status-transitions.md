# 0052 — Versioned order status transitions

- Date: 2026-10-13
- Status: accepted
- Step(s): 84

## Context

Staff must move an order through the normal fulfilment path without skipping or repeating states. Two operators may act on the same order, a client may retry after losing the response, and every accepted change must leave one history row, audit record and domain event. Delivery does not prove that cash was collected.

## Decision

`POST /v1/admin/orders/:id/transitions` requires the current `orders.transition` grant, a valid admin Origin and a fail-closed per-address/per-actor limit. Its strict body is `{to, expectedVersion, commandId}`. `to` accepts only `confirmed`, `processing`, `out_for_delivery` or `delivered`; cancellation remains a separate command. The response is a small transition receipt with order ID, from/to status, resulting version, database timestamp and staff actor. It contains no order contact or mutable order detail.

The repository locks the active actor with the permission, then locks the order. It compares `expectedVersion`, applies the shared domain state machine, increments the version once and writes dispatch/delivery timestamps when those states are reached. The same transaction appends status history, audit and the IDs-only `order.status_changed` outbox event. PostgreSQL's deferred order/history consistency trigger is the final invariant.

Staff transition command IDs are globally unique through a partial history index; creation rows retain their stable internal labels. A retry with the same actor, order, target and preceding version returns the original receipt with `replayed: true`; any reuse for another payload, actor or order is `COMMAND_REUSED`. Concurrent duplicates serialize on the order or the unique command constraint. A stale version is `VERSION_CONFLICT`, and a state-machine violation is `INVALID_TRANSITION`.

The admin detail offers exactly the next normal action to staff with `orders.transition`. It sends the version displayed in the detail and retains the generated command ID after an uncertain failure, so reloading current values and retrying cannot create a second transition. After success it reloads the authoritative detail and timeline.

## Consequences

- The allowed path is Pending → Confirmed → Processing → Out for Delivery → Delivered; terminal, reverse and skipped moves are refused.
- History records the actor, database time and resulting order version, while command IDs remain private.
- Moving to Delivered leaves `cod_status=pending`; step 87 owns collection evidence.
- Cancellation, order edits, manual orders and bulk confirmation remain steps 85–89.
