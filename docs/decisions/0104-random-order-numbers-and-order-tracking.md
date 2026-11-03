# 0104 — Random order numbers, tracking by order number, fuller order emails

- Status: Accepted
- Date: 2026-11-03
- Decided by: Marina (client feedback)

## Context

The client asked for three things:

1. Customers should be able to track an order's status by its order number.
2. Tracking must need the order number only, with nothing else to type.
3. Both order emails should include the order number, the customer's name, email and phone, and the product details. These are the shopper's confirmation (ADR 0102) and the shop's new-order email (step 78).

Order numbers were sequential (`IH-001001`, `IH-001002`, …), taken from an identity column. Architecture §7 forbids "order-number-only access" for exactly this reason: anyone could read other people's orders by counting. The shop's new-order email deliberately left out who ordered (ADR 0047).

Marina's decision: tracking uses the order number alone. To make that safe, new order numbers become random so they cannot be counted.

## Decision

### Random order numbers

- New orders get a random 12-digit number in the range 100000000000 to 999999999999, shown as `IH-482193057316`.
  - Migration `20261103000100_random_order_numbers` drops the identity from `orders.order_number`.
  - A `BEFORE INSERT` trigger, `orders_assign_number`, assigns the number from 48 bits of `gen_random_uuid()`, which uses `pg_strong_random`. It retries until the number is unused, and the unique constraint stays in place.
- The number still cannot be chosen or changed. An INSERT that sets it, or an UPDATE that changes it, is refused with `428C9`, the same error the identity column gave. The trigger's name sorts before `orders_guard`, so it runs first.
- The migration is expand-only. The previous release never writes `order_number`, so it keeps working during the deploy.
- **Existing orders keep their sequential numbers.** They are never trackable: the lookup refuses any number outside the random range (`isTrackableOrderNumber`).
- The displayed format stays `IH-` followed by digits. Every existing contract regex (`^IH-\d{6,}$`), the admin search and WhatsApp templates accept it unchanged. `parseOrderNumber` now also accepts spaces or dashes between digits (`IH 4821 9305 7316`).

### Tracking

- `POST /v1/store/order-tracking` takes `{orderNumber}` and is behind the age ticket.
  - It is a POST, so the number, which is what grants access, never appears in a URL, server log or browser history.
  - Responses are `private, no-store` with `no-referrer`.
- **What it shows:**
  - status, and a timeline of the statuses reached, with times
  - items, with options, quantities and prices
  - subtotal, discount, delivery and total
  - the delivery ETA text
  - the area and emirate
- **What it never shows:** name, phone, email, address lines, notes, the cancellation reason or internal IDs. Anyone holding the number sees the page, so it carries nothing personal.
- **Same answer when nothing is found.** A malformed number, a sequential number and a random number with no order all get the same 404.
- **Guessing limits**, all fail-closed:
  - Every lookup counts: 20 per minute per address.
  - Misses count separately: 10 per 15 minutes per address, and 300 per hour across the whole store.
  - Once a miss budget is spent, lookups are refused before the number is checked, so a refusal never reveals whether a number was right.
  - With 9 × 10¹¹ possible numbers, the store-wide budget limits even a guesser with many addresses to about 7,200 tries a day. At 10,000 orders, that finds one order roughly once every 34 years.
  - The cost: a flood of wrong numbers can make tracking say "try again later" for up to an hour. Customers can still use WhatsApp.
- **Storefront `/track`:** a single field and a status stepper. The number is held only in the page's memory, and the page is `noindex` and behind the age gate. It is linked from the footer, the menu, the order confirmation page and the customer email.

### Order emails

- **Customer confirmation (template `order.confirmation` v2):**
  - adds the order number, name, phone and email given at checkout
  - adds a link to `https://<store domain>/track`. The link never carries the number; the email shows the number to type in.
- **Shop new-order email (template `order.new` v3):**
  - adds the customer's name, phone and email ("Not given" for a staff-entered order without one)
  - adds the order lines
  - still leaves out the delivery address and any link that grants access. The address stays in the admin.
- The in-app new-order notification is unchanged: it still stores no customer detail.

## Consequences

- An order number in the new format is now a bearer reference: whoever has it sees the order's status and contents, but no personal data. This supersedes the "no order-number-only access" rule in architecture §7, for the tracking route only. The confirmation route keeps its cookie capability.
- The shop's mailbox now holds customer names, phones and emails. Who can read that mailbox becomes part of who can see customer data.
- **Tests:**
  - Sequential-number assertions now expect the random format.
  - The db tests check the trigger: a random number, no sequence, `428C9` on choose or change.
  - The API tests check the tracking route: no PII in the answer; misses look the same and are bounded per address; the age ticket is required.
  - The worker tests check that the new emails name the customer but never the address.
