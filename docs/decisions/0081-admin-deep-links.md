# 0081 — Admin deep links

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A2 (follows ADRs 0074, 0058, 0063 and 0047)

## Context

Every admin screen kept its open record and its filters in component state. A link from the notification bell, the inbox, the dashboard, a customer's history or a review could only open an unfiltered list, and the staff member had to find the record again. A reload or the browser's Back also lost the view. The prototype opens the exact order, product or stock line from each of these places. Marina chose G-A2 as the second tier-L parity gap to build before step 120 (2026-10-17).

## Decision

**The URL holds the view.** A shared `useUrlQuery` hook reads and writes the page's query string. Opening a record pushes a history entry; changing a filter replaces the current one. Each screen reads its own parameters:

| Screen    | Parameters                                                      |
| --------- | --------------------------------------------------------------- |
| Orders    | `order=<id>` (detail), `status=<status>`, `delayed=1`           |
| Products  | `product=<id>` (editor; a new product stays local state)        |
| Inventory | `variant=<id>` (one stock line, with "Show all stock"), `state` |
| Customers | `customer=<id>` (detail)                                        |

- Only UUIDs are read from or written into a link. A malformed ID opens the list. `lib/links.ts` builds every link, and maps a notification's stored API path (`/orders/<id>`, `/inventory/<id>`, `/reviews`) to its screen. Anything else gets no link, so a stored value can never become an outside or free-text URL.
- When a link changes the filters while a list is open, paging starts again from the first page.

**API filters.** `GET /v1/admin/orders?delayed=true` uses the dashboard's delayed rule (`DELAYED_ORDER`, now shared by `dashboard.ts` and `order-admin.ts`), so the dashboard count and the linked list always agree. `GET /v1/admin/inventory?variantId=` returns one stock line. Both keep their existing permissions.

**Links added:**

- **Bell and inbox:** the exact order, or the exact stock line.
- **Dashboard:** pending, delayed and out-for-delivery go to filtered lists; recent and attention orders open the order; low-stock lines open their stock line; top products open the product.
- **Customer history:** each order opens that order.
- **Reviews:** the order (with `orders.read`) and the product (with `catalog.read`).

A "Delayed only" toggle sits next to the status tabs.

## Consequences

- Links, reloads and Back keep the view. Rights are still checked by the API on every read; a link never grants access, and a screen the user cannot open still says "Access unavailable".
- The search text and date filters of the orders list stay local; only the filters that links use are in the URL.
- The order detail cannot link to its customer yet: the order response carries no customer ID. That stays for a later change if needed.
