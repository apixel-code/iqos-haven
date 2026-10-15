# 0057 — Bulk confirm with per-order results

- Date: 2026-10-15
- Status: accepted
- Step(s): 89

## Context

Roadmap step 89: bulk confirm with per-order results and retry handling. Done condition: bounded selection, expected versions, mixed failures shown, no duplicate transition. Architecture §6: "Per-order versioned transitions, bounded batch, individual outcomes; retry cannot confirm twice."

## Decision

`POST /v1/admin/orders/bulk-confirm` with `orders.transition`, admin Origin and the per-address and per-actor staff limit. The body lists 1–50 orders, each with the `expectedVersion` the operator saw and its own UUID `commandId`; an order or a command ID may appear only once.

Each order is confirmed by the existing `transitionOrder` (ADR 0052) in its own transaction, one after another in the order given. One order's refusal never undoes or blocks another. The answer has one result per order: `confirmed` (with `replayed` when that command had already confirmed it) or `refused` with a code — `VERSION_CONFLICT`, `INVALID_TRANSITION`, `COMMAND_REUSED`, `NOT_FOUND`, `FORBIDDEN` or `TRANSACTION_RETRY_EXHAUSTED`.

No duplicate transition: the transition command ledger is global (unique command ID), so the same batch sent again, or twice at once, replays each confirmation; a new command for an order already confirmed fails its expected version.

**Admin.** Pending orders in the list can be ticked (up to 50). "Confirm selected" sends them with one command ID each and lists every order's result. After an unclear answer (no answer or a server error) the selection is locked and the button becomes "Retry confirming", sending the same batch with the same IDs.

## Consequences

- A batch is not atomic by design: a partial failure leaves the other orders confirmed.
- Every confirmation writes its own history row, audit entry and `order.status_changed`, as a single confirmation does.
- An unexpected error on one order ends the request with a 500 instead of a per-order result, so the operator never sees an unexplained "refused": the earlier orders stay confirmed, and "Retry confirming" sends the same batch, which replays them and continues. "Discard and reload" leaves the batch; a new selection re-checks every version.
- Order and command IDs are compared in lower case, so a retry spelled in capitals is the same command.
