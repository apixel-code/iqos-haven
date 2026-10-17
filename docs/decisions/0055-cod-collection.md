# 0055 — Cash-on-delivery collection and Owner corrections

- Date: 2026-10-14
- Status: accepted
- Step(s): 87

## Context

Roadmap step 87: explicit COD collection and the Owner's correction. Done condition: Delivered does not auto-collect; amount, time, actor and reference are recorded; a correction is audited and preserves the original evidence. Architecture §6: collection is a separate authorized action that requires Delivered; correcting it is Owner-only, needs a reason and an audit event, and cannot erase the original. The orders table already holds `cod_status` and the collection fields and refuses rewriting them once cash is recorded (ADR 0042).

## Decision

**Recording.** `POST /v1/admin/orders/:id/collection` with `orders.collect` (Owner and Staff): `expectedVersion`, a UUID `commandId`, `amountFils` (integer, 0 to 10¹²), an optional `reference` (1–100 characters) and an optional `collectedAt`. Only a Delivered order whose cash is pending; anything else is `COLLECTION_NOT_ALLOWED`. The time defaults to the database's now; a given time must not be in the future or before the minute of delivery (staff enter it to the minute), else 400. The amount may differ from the order total (the admin asks for confirmation); it is recorded as received.

**Correcting.** `POST /v1/admin/orders/:id/collection/corrections` with `orders.collection_correct` (Owner): the full corrected record (amount, reference, time) and a `reason`. Only when cash is recorded (`NOT_COLLECTED` otherwise); a record equal to the one in effect is `NO_CHANGES` (times compared to the millisecond, the API's precision). The admin keeps the exact recorded time when its minute-only field is left unchanged.

**Evidence is never rewritten.** The order's collection fields hold the first record and stay as they were (the existing guard). Every command, the first record and each correction, is one immutable row in `order_collection_records`, in order; the latest row is the one in effect. One `recorded` row per order (unique index). A deferred trigger requires, at commit, that the order is Delivered and collected at the row's version, and that a `recorded` row equals the order's own fields; the first row copies the time from the order in SQL, so no precision is lost.

**One transaction each:** the actor's right (row locked), the command replay check, the order lock and version, the state checks, the order update (cash fields for a record; version only for a correction), the record row, an audit entry (`order.collection_recorded` or `order.collection_corrected` with before and after amount, time and reference, and the correction's reason) and the matching event (`order.collection_recorded` or the new `order.collection_corrected`, IDs only, no consumers yet). The same command ID with the same actor, order and request replays the receipt; otherwise `COMMAND_REUSED`. Two different commands racing on one order: one records, the other is refused.

**Admin.** The payment card lists the record and corrections, marking the one in effect. Staff with `orders.collect` see "Record cash collected" on a Delivered order with cash pending, prefilled with the order total; amounts are typed in AED and converted to fils as text, never through floating point. The Owner sees "Correct cash record" once cash is recorded.

## Consequences

- Reports of collected cash (step 106) must use the latest record per order, not only the order's fields, and index by collection time (`orders_collected_at` covers the original).
- The order's `collectedAmountFils`, `collectedAt` and `collectionReference` in the admin detail are the original evidence; after a correction the amount in effect is the last `collectionRecords` entry.
- A recorded collection cannot be undone into "pending"; a mistaken record is corrected (for example to the right amount). Collected orders cannot be cancelled: they are Delivered.
- The reference is free text for a receipt or courier slip number; staff should not put customer details in it.
