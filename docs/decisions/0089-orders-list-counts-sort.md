# 0089 — Orders list: tab counts, sorts, select-all and phone cards

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A5 (follows ADRs 0051, 0057 and 0081)

## Context

The admin orders list had status tabs without counts, one fixed order (newest first), a checkbox per row for bulk confirm but no way to choose a page at once, and a wide table that scrolled sideways on a phone. The prototype (`VIEWS.orders`, `orderRowM`) has all four. Marina chose G-A5 for launch (2026-10-17). "Delayed only" already exists (ADR 0081).

## Decision

- **Counts:** `GET /v1/admin/orders/counts` (`orders.read`) returns the number of orders per status and in all. It applies the list's other filters: search, dates and delayed. The tabs and the list therefore always agree, as in the prototype. The header reads "N orders · M waiting for confirmation". Only numbers are returned, nothing personal; a contact search still matches contacts only for staff with `customers.read`.
- **Sorts:** `sort` on the list is newest first (default), oldest first, highest amount or lowest amount. It is kept in the URL.
  - Each sort pages by its own keyset: `(created_at, id)` or `(total_fils, id)`. The cursor names its sort, so a cursor from another sort is refused (400). An older two-part cursor is read as newest first.
  - Amount sorts have no index. At the measured volume (step 121) a full sort of the filtered orders is cheap. An index can follow if the history grows tenfold.
- **Select-all:** a header checkbox selects every pending order on the page (within the bulk limit of 50), shows a mixed state when only some are chosen, and clears them again. Only pending orders can be confirmed, so only they are selectable, as before.
- **Phone cards:** below 700px the table gives way to one card per order: number and status; customer and amount; time, items and area. A tap opens the order.
- **Not copied from the prototype:** mobile "Quick confirm" (ruled out in ADR 0074) and its fake Undo; client-side filtering, sorting and paging (all server-side here).

## Consequences

- Staff see at once how many orders wait in each state, can work largest or oldest first, and can confirm a whole page in one action.
- One more read per list view (the counts). It is a single grouped count over the filtered orders.
