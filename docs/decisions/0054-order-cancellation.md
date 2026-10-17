# 0054 — Order cancellation and returns

- Date: 2026-10-14
- Status: accepted
- Step(s): 86

## Context

Roadmap step 86: cancel before handoff, and the Owner's cancellation after handoff once the goods have come back. Done condition: reason and command ID; one release; only received resellable quantity restored; Delivered cancellation forbidden. Architecture §6 "Order state machine" (cancel before handoff, cancel after handoff, cancel Delivered) and the COD rules. Orders may have been edited (ADR 0053), which already moved stock by net deltas.

## Decision

**Route.** `POST /v1/admin/orders/:id/cancel` with `expectedVersion`, a UUID `commandId`, a `reason` (1–500 characters, trimmed) and, for a return only, `returnItems` (`variantId`, `resellableQuantity`, `damagedQuantity`). Admin Origin, a fail-closed per-address and per-actor limit, `Cache-Control: no-store`.

**Who may cancel what.**

| Order status                   | Rule                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending, Confirmed, Processing | `orders.cancel_before_dispatch` (Owner and Staff). Every unit the order holds goes back. A `returnItems` list is refused (400).                                                                                                                     |
| Out for Delivery               | Also `orders.cancel_after_dispatch` (Owner). Every order line must be classified exactly once, resellable + damaged = quantity sent, nothing else listed; otherwise `RETURN_INCOMPLETE`. Only resellable units go back; damaged units are recorded. |
| Delivered, Cancelled           | `ORDER_NOT_CANCELLABLE`. Returns of delivered goods are a later workflow.                                                                                                                                                                           |

**One transaction**, in the canonical lock order: the actor (rights rechecked, row share-locked) → the command record → the order (`lockOrder`, version checked) → the coupon use (`releaseCouponRedemption`) → the variants (`lockVariantsForStock`, sorted). Then: stock movements, the order update (`cancelled`, `cod_status = not_collected`, reason, `cancelled_at`, `returned_at` for a return, version + 1), the history row with the reason, the cancellation record, the return lines, a metadata-only audit entry (counts and flags; not the reason) and `order.cancelled`. Any failure rolls all of it back.

**Stock comes back once, enforced by the database.** Two ledger reasons: `ORDER_CANCEL` (command ID `cancel:<order id>`, effect `order_cancel`) and `ORDER_RETURN` (`return:<order id>`, `order_return`), both positive and tied to the order. With the ledger's unique `(command_id, variant_id, effect)`, each variant of an order can be returned to stock once, whatever the application does. The quantity is what the order holds now (`order_items`), which already includes every edit, so an edited line is never returned twice. Every movement calls `publishLowStockCrossing`.

**The command record.** `order_cancellations`: one row per order (primary key), unique command ID, actor, kind (`before_handoff` | `returned`), the status it came from, the request hash, the version it produced and whether a coupon use was released. Immutable; a deferred trigger requires the order to be cancelled at that version when the transaction commits. `order_return_items` keeps sent, resellable and damaged units per line, immutable, with resellable + damaged = sent. The same command ID with the same actor, order and request replays the original receipt (`replayed: true`); anything else with that ID is `COMMAND_REUSED`. The history row reuses the command ID, so it also cannot collide with a transition command.

**Receipt.** Order ID, kind, previous status, new version, reason, time, actor, the units restocked and the units recorded as damaged per SKU, and whether a coupon use was released. Rebuilt from the stored rows on replay, so it is the same every time.

**Admin.** The order detail shows a cancel panel to holders of the permission for the order's state, keeps one command ID per order version so a retry is safe, asks for confirmation, and shows how a returned order came back. A return needs the item variant IDs, which the detail shows only to `orders.edit` holders; the Owner has it.

**Also fixed here.** The inventory movement contract did not list `ORDER_EDIT` (step 85), so the stock history of an edited variant could not be read; it now lists `ORDER_EDIT`, `ORDER_CANCEL` and `ORDER_RETURN`, with admin labels.

## Consequences

- A replay is answered only while the actor still holds the cancel permission: someone deactivated or demoted since gets 403, not the stored receipt.
- The admin panel keeps its command ID until the order changes; pressing again after changing the reason is a different request and is answered `COMMAND_REUSED` ("Reload and try again").

- A cancelled order is final. Correcting a wrong cancellation is a new order, not an undo.
- Damaged units are recorded on the order only; they never enter the stock ledger.
- The reason is visible to staff in the order history; the audit log does not repeat it.
- Collection rules: an order with cash recorded is Delivered and therefore cannot be cancelled.
