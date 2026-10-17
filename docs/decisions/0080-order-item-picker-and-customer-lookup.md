# 0080 — Order item picker and returning-customer lookup

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-A1 (follows ADRs 0053 and 0056, which deferred the picker)

## Context

The manual order (ADR 0056) and the order edit (ADR 0053) took items as a typed variant UUID. Staff cannot know a UUID, so neither form was usable in practice. The manual order also could not recognise a customer who had ordered before. The prototype (`VIEWS["order-new"]`, `noRes`, `noItems`) searches products by name, brand or SKU, and looks the customer up by phone first. Marina chose G-A1 as the first of the four tier-L parity gaps to build before step 120 (2026-10-17).

## Decision

**Item picker.** `GET /v1/admin/orders/item-choices?q=` returns at most 30 variants that the order transaction would accept now: the same rule as `priceRows` (store visibility, an active variant, a price above zero). It matches the product name, brand name or SKU (case-insensitive, LIKE wildcards escaped). Each row has the brand, product, option values in the product's option order, the SKU, the unit price and `soldOut`.

- **Access:** `orders.create` **or** `orders.edit`. The access guard gains `@RequireAnyPermission(a, b, ...)`, which needs at least two keys and must still be paired with `@Serialize` (the startup check covers it).
- **Stock** appears only as sold out or not. A stock count needs `inventory.read`, which a staff member who only takes orders may not have.
- **Price** is a guide only. The server quote stays authoritative, and the order still re-prices and locks as before.
- **Admin:** one `OrderItemPicker` component serves both forms. A variant already in the order, or sold out, cannot be added. The order edit can add several items at once, sent as `added.<variantId>` quantities in the existing `lines` command.

**Returning-customer lookup.** No new route: with `customers.read`, the manual order normalises the typed number with the shared `normalizePhone` (now re-exported by `@ih/contracts`). It searches `/admin/customers?q=`, keeps only the exact E.164 match, then reads `/admin/customers/:id`. The admin customer detail's saved addresses now carry `areaId`. "Use this address" fills the area and address fields; an area that is no longer served is named instead of filled. The name is filled in. A no-show flag is shown. Spend is not shown here.

**Fix found by the browser pass.** The manual order form spread the quote input (including a top-level `areaId`) into the strict order request, so every submission from the admin failed validation. The request now takes only `lines` and `couponCode` from it.

## Consequences

- Staff can place and edit orders without seeing IDs. The order transaction, idempotency, locks and money rules are unchanged.
- The customer lookup costs two reads and stays inside `customers.read`. Without that right the button is not shown and the form works as before.
- The picker lists at most 30 rows. Staff narrow it by typing; there is no paging.
