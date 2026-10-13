# 0051 — Admin order list and snapshot detail

- Date: 2026-10-13
- Status: accepted
- Step(s): 83 (commands: 84–89; customer views: 90)

## Context

Staff need to find a committed order and inspect exactly what was accepted before any operational command is added. Order numbers identify records but grant no access. Order, item, address, price and history snapshots must remain stable when catalogue, delivery or customer records later change. Customer contact is a separate permission from order operations.

## Decision

`GET /v1/admin/orders` and `GET /v1/admin/orders/:id` require `orders.read` and return `private, no-store`. The list is newest first with a `(created_at,id)` keyset cursor, a 1–100 page bound, optional six-state status, half-open placement window (`from <= created_at < to`) and a 100-character search. Search recognizes a complete display order number. Name and phone search runs only when the current actor also has `customers.read`, so a filtered result cannot reveal contact data to another permission set.

The detail is read with its items and append-only status history in one repeatable-read snapshot. Responses contain operational snapshots and omit customer/catalogue foreign keys, creation/idempotency hashes, quote and confirmation credentials, command IDs and tax/config internals. Customer name, phone, address, Makani and notes form one optional `customer` field protected by `customers.read`; API field policy and repository authorization both fail closed. History exposes the display name of a staff actor, not account contact details.

The admin Orders screen provides status/date/search filters, bounded forward/back paging, responsive list rows, snapshot totals/items/contact and the history timeline. It contains no status, edit, cancellation, collection, manual-order or bulk action; those commands belong to steps 84–89 and must use expected versions.

## Consequences

- A staff member can operate from historical facts even after related live records change.
- Revoking either permission takes effect on the next request because both route and repository read current database grants.
- Unfiltered/date pages use `orders(created_at DESC,id DESC)`; the existing status index serves status pages. Literal contact searches are bounded but initially scan the filtered order set. A trigram/search projection requires measured production query evidence.
- Customer aggregates, history by customer and WhatsApp templates remain step 90.
