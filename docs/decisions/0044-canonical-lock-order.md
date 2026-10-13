# 0044 — Canonical lock order, enforced at run time

- Date: 2026-10-12
- Status: accepted
- Step(s): 75 (order creation: 76; edits: 85; cancellation: 86)

## Context

Roadmap step 75: canonical lock-order transaction helpers; Read Committed; customer → settings/area → catalogue → coupon → variants, after the existing order when there is one; deterministic order. Architecture §5: lock each group in a deterministic key/ID order, skip unused groups, and never acquire an earlier group after a later one.

Steps 65–74 built one lock primitive per group. A rule that lives only in comments is broken by the first caller that gets the sequence wrong, and the result is a deadlock that appears only under load.

## Decision

**Seven groups, front to back** (`LOCK_GROUPS`, `@ih/db`):

| Group       | Primitive                                       | Locks                                                                      |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| idempotency | `claimIdempotency`                              | The command's key                                                          |
| order       | `lockOrder`                                     | The existing order, FOR UPDATE (edits, status changes, cancel, collection) |
| customer    | `lockCustomerForOrder`                          | The customer row, FOR UPDATE                                               |
| delivery    | `lockDeliverySelection`                         | The delivery settings, then the area, FOR SHARE                            |
| catalogue   | `lockOrderPrices`                               | Brands, categories, products, FOR SHARE, each in ID order                  |
| coupon      | `lockCouponForOrder`, `releaseCouponRedemption` | The coupon row, FOR UPDATE                                                 |
| variants    | `lockVariantsForStock`                          | Variant rows, FOR UPDATE, in ID order                                      |

**The order is checked while the code runs.** Every primitive calls `enterLockGroup` before its first locking statement. Entering the same or a later group is fine; entering an earlier group after a later one throws `LockOrderError` before any statement is sent. It is a programming error, is never retried, and fails the first test that walks a wrong sequence.

**One walk for order creation.** `lockForOrderCreation(tx, { customer, quote })` runs customer → quote (delivery, catalogue, coupon) → variants and returns what was read under those locks. Step 76 calls it after the idempotency claim.

**Rules the tracker also enforces:**

- A saved address references an area (a key-share lock). It is saved after `lockDeliverySelection` holds that area; a transaction that saved an address first can no longer ask for the delivery selection.
- `markCustomerFirstOrder` only for a customer the transaction locked.
- `releaseCouponRedemption` only after `lockOrder`.
- `lockVariantsForStock` sorts, deduplicates and lower-cases the IDs; a malformed or unknown variant fails the command by name. `lockOrder` treats a malformed ID as an unknown order.

**Admin commands** are not tracked. They take the staff row, then one resource, or parent → product → variants; all of that runs in the same direction as the order walk, so they can make an order wait but cannot form a cycle with it.

## Not built here

- Consuming stock and writing the order (step 76).
- A group for the staff row. A staff-entered order references its operator (key-share only); step 76 decides whether to take the staff row before the customer, as admin commands do.

## Alternatives considered

- **Documentation and review only.** Rejected: see Context.
- **A static lint rule.** Rejected: the sequence depends on run-time paths; a run-time check is exact and cheap (one map lookup per primitive).
- **Locking the order row inside coupon release.** Rejected: the caller already holds it; the check keeps one place responsible.

## Consequences

- A new lock primitive must call `enterLockGroup` first, or it is invisible to the check.
- Implicit locks from foreign keys and triggers are not tracked. They were reviewed for the planned order creation: each references a row the transaction already holds at least as strongly, or a row it has just inserted.
