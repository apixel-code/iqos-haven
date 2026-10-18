# 0092 — Products list: SKU search, stock state, sorts and thumbnails

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A8 (follows ADRs 0018, 0089 and step 44)

## Context

The admin products list searched names only, showed no stock, could not filter by it or sort, and had no thumbnails. The prototype's list (`VIEWS.products`) has all four. Marina chose G-A8 for launch (2026-10-17).

## Decision

- **Search:** `q` matches the product name or any of its option SKUs (case-insensitive; `%` and `_` are literal, as before).
- **Stock state:** each list item carries `stock: { onHand, state }`, computed over **active** options only:
  - `out` when no active option has stock (or the product has no active option);
  - `low` when an active option is at zero or at or below its alert level;
  - otherwise `in_stock`.
  - `stock=in_stock|low|out` filters on it.
- **Stock is `inventory.read` data:** the route's field policy strips `stock` for callers without it, and the `stock` filter answers 403 for them, so a filter cannot reveal what the field hides.
- **Sorts:** `sort=newest` (default), `name` (case-insensitive A–Z), `price_asc`, `price_desc` (base price). Each is a keyset over `(key, id)`. The cursor is opaque base64url of `[sort, key, id]`, and a cursor of another sort answers 400. A bare id is still read as a newest-first cursor (the earlier format).
- **Thumbnail:** the main image's (else the first image's) `thumb` derivative, signed for ten minutes; `null` when the product has no image.
- **Admin:** "Search name or SKU"; Stock (only with `inventory.read`) and Sort selects; each row shows the thumbnail or a placeholder, and a stock tag with the on-hand count. The rows stay cards (no wide table), so phones need no second layout.

## Consequences

- Staff can find a product from the SKU on a box or an order line, and see at a glance what needs restocking.
- Sorting by stock is not offered: it would need a keyset over a computed value. The Stock filter covers the restocking question.
- Every list request signs up to 25 thumbnail links; signing is local (no network call).
