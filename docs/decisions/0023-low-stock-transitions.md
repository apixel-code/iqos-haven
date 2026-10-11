# 0023 — Variant low-stock transitions and durable events

- Date: 2026-10-11
- Status: accepted
- Step(s): 53 (consumers: notification/email step 92; order stock writers steps 75–76, 85–86)

## Context

Roadmap step 53: a variant emits a low-stock event once when it moves from above its threshold to at or below it, re-arms after restock, and zero stock never unpublishes. Architecture §6 adds that threshold edits re-evaluate explicitly without repeating alerts while the variant is already low, and that emission is deduplicated.

Stock changes only through `stock_movements` (ADR 0017); the movement trigger applies the delta under the variant row lock. Thresholds change only through the variant editor (ADR 0016), which also locks the variant row.

## Decision

**One pure rule** (`@ih/domain` `crossedIntoLowStock`): a change crosses when the variant was above its threshold before and is at or below it after. Either side may move. Low means `stock <= threshold`, so the default threshold 0 alerts when the last unit goes.

**No armed flag is stored.** "Armed" is simply "currently above the threshold". The rule is evaluated from the before/after levels read under the variant row lock, in the same transaction as the change:

- `runStockCommand` (adjust and set) reads stock and threshold `FOR UPDATE`, inserts the movement, and calls `publishLowStockCrossing` with cause `stock`.
- `updateVariant` holds the variant lock and calls it with the old and new threshold, cause `threshold`.

The row lock serializes every writer, so concurrent changes see each other's result and exactly one of them observes the crossing. A replayed command inserts no movement and therefore emits nothing. A rolled-back change takes its event with it.

**Event.** `inventory.low`, aggregate `variant`, payload `{ variantId, cause: "stock" | "threshold" }`. No stock figures, SKU or names: consumers load current data. Threshold events carry the new variant version as `aggregateVersion`; stock movements do not bump the variant version, so stock events carry none. Consumers deduplicate on the event ID, as every consumer does.

**No consumer yet.** `notification` and `email` stay planned for step 92, so the event is durable but has no effects. Step 92 must record its backfill decision for events written before it (architecture §8).

**Emitted for every variant**, including inactive ones and variants of draft or trashed products. Whether an alert is worth sending is the consumer's decision at delivery time, from current data.

**Zero stock changes nothing else.** No code path touches product status or `active` from a stock movement; the test asserts it.

**Ledger reconciliation.** The worker runs `inventory.reconciliation` hourly: `stockReconciliationMismatches` should be empty; any row is logged as an error with variant IDs for alerting. Read-only.

## Alternatives considered

- **`low_stock_armed` column.** Rejected: it duplicates what stock and threshold already say, and a second source of truth can drift. It would also need a migration and a backfill.
- **Emit from the movement trigger.** Rejected: the outbox writer snapshots required consumers in application code; reproducing that in PL/pgSQL would split the event contract across two languages.
- **Emit only for active, published variants.** Rejected: a variant reactivated while low would then never alert, and the rule would depend on product state the stock path does not lock.

## Consequences

- **Every future stock writer must call `publishLowStockCrossing`** in its transaction with levels read under the variant lock: order creation, order edits and cancellation (steps 75–76, 85–86). Step 54's acceptance pass and those steps must test it.
- Reactivating a variant that is already low emits nothing; it alerts again only after rising above the threshold.
- A variant created with stock 0 emits nothing until it has been above its threshold once.
- Without a consumer, `inventory.low` events complete immediately. The admin inventory list already shows the low and out states.
