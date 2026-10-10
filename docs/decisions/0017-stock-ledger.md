# 0017 — Stock ledger: trigger-verified movements, replay-safe adjustments

- Date: 2026-10-10
- Status: accepted
- Step(s): 46 (extended by 47, 53, 73–79, 86)

## Context

The relevant rules come from the root `CLAUDE.md`, architecture §5–6 and the roadmap:

- Stock changes only through `stock_movements`, which is append-only.
- Movements carry a signed delta, the resulting balance, a reason, a command reference and the actor.
- Command/variant/effect is unique.
- Stock is never negative.
- A reconciliation compares balances with ledger sums.
- Initial stock and restock start from zero.

Step 41 guarded `variants.stock_on_hand` with a transaction-local session flag. Any caller could set that flag, so it does not count as a ledger guarantee.

## Decision

**Movements apply themselves.** Inserting into `stock_movements` is the only way to change stock.

- The writer computes `balance_after` under the variant row lock.
- An `AFTER INSERT` trigger then runs `UPDATE variants SET stock_on_hand = stock_on_hand + delta`, which locks the variant row, and checks that the result equals `balance_after` (otherwise `IH002`). Only after that does it check that `INITIAL_STOCK` is the first movement (`IH001`).
- The trigger is AFTER rather than BEFORE so that a row skipped by `ON CONFLICT DO NOTHING` never touches stock, and a multi-row insert with one bad row rolls back as a whole. The movement and the balance therefore commit together or not at all.
- The variant CHECKs require `0 ≤ stock_on_hand ≤ 100,000,000`. This is the conditional write later used by checkout.
- The variant guard allows stock changes only from inside a trigger (`pg_trigger_depth() >= 2`). A direct `UPDATE` is refused whatever session settings the caller uses; this replaces the step-41 flag. Future migrations must not add any other trigger that updates `variants.stock_on_hand`.

**Reasons for now:** `INITIAL_STOCK`, `RESTOCK`, `MANUAL` and `DAMAGE`. The order reasons (sale, release, return) arrive with orders.

- `INITIAL_STOCK` adds stock and is allowed once per variant, only as its first movement (partial unique index plus trigger check).
- `RESTOCK` adds stock.
- `DAMAGE` removes stock and needs a note.
- `MANUAL` can add or remove stock and needs a note.
- Deltas are nonzero and bounded at ±1,000,000.

**Append-only.** `UPDATE`, `DELETE` and `TRUNCATE` on the ledger are refused by triggers and revoked from `ih_app`.

**Adjustment API.** `POST /v1/admin/inventory/:variantId/adjustments` requires `inventory.adjust`. The body is `{ commandId, reason, delta, note? }`.

- One transaction: actor share lock and permission recheck, then the variant `FOR UPDATE`.
- After the lock, the command ID is checked again, so a concurrent duplicate that committed first is replayed rather than failing a stock check.
- `INSUFFICIENT_STOCK`, `STOCK_LIMIT` and `INITIAL_STOCK_EXISTS` are checked up front. The database is the backstop, and an unexpected CHECK failure stays a loud server error.
- The movement is inserted with the actor, and an audit entry records before/after balance, delta, reason and `noteProvided`. The audit never stores the note text.
- **Replay:** sending the same `commandId` and payload again returns the original movement (`replayed: true`). A command ID names one action, so reusing it with a different payload or for another variant is `COMMAND_REUSED`.
- Adjusting a trashed product's or an inactive variant's stock is allowed, because physical stock still exists (for example, recording damage before a purge). When a concurrent duplicate loses on the unique key, the request rolls back and reads the committed winner in a fresh transaction (architecture §5).

**Reads** (`inventory.read`):

- `GET /v1/admin/inventory` lists variants with their stock state (`out` at 0, `low` at or below the threshold, otherwise `in_stock`). Zero stock never unpublishes. Filters: product, state, and a literal SKU/name search. Keyset paging by variant id.
- `GET /v1/admin/inventory/:variantId/movements` returns the item and its newest-first history in one REPEATABLE READ snapshot.

**Reconciliation.** `stockReconciliationMismatches(db)` lists variants whose balance differs from their ledger sum or from their latest movement's `balance_after`. Scheduling it and alerting on mismatches are part of the low-stock/alert work (step 53).

## Alternatives considered

- Application code computes `balance_after` and updates the variant separately: two writes can drift if any code path forgets one of them. The trigger makes drift impossible.
- Keep the step-41 session flag: any session could set it.
- An expected-version check on delta adjustments: deltas commute, so no expectation is needed. Absolute set-stock (step 47) needs the expected current balance and computes the delta under the row lock.

## Consequences

- Step 47 adds set-stock (expected balance → computed delta) and the inventory UI.
- Orders (73–79) insert sale, release and return movements with order references and effect names; the reason CHECK is widened then.
- Low-stock crossing events (step 53) read the movement balances.
- Every stock write in any later step must be a movement insert with a correct `balance_after`, computed under the variant lock. There is no other path.
