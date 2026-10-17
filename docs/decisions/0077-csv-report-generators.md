# 0077 — Five CSV report generators and the streamed download

- Date: 2026-10-16
- Status: accepted
- Step(s): 111 (built files: 112)

## Context

Roadmap step 111 asks for the five CSV generators (Sales, Orders, Products, Inventory and Customers) with three conditions: the snapshot or date basis is documented, spreadsheet formulas are sanitized, and customer personal data is audited. Architecture §14 gives each report's basis. ADR 0076 stores typed requests as `report_jobs`, with a `stream` job for up to 5,000 estimated rows. The prototype's `csvData` shows the columns the client expects.

## Decision

**Encoding** (`packages/domain/src/csv.ts`): RFC 4180 with commas, CRLF line ends and quoting where needed, in UTF-8 with a byte-order mark.

- Text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, so a spreadsheet shows it as text instead of running it. This includes phone numbers (`'+971…`).
- Numbers are written only from values the report computed (`CsvNumber`, integer counts). Amounts are AED with two decimals, from integer fils, without floats. Times are Dubai wall-clock time.

**Generators** (`packages/db/src/report-csv.ts`, `reportRows`): each report yields a header row and then its rows, reading in keyset batches of 1,000 so a large report (step 112) never holds everything in memory. A timestamp in a cursor is read as text at microsecond precision: a JS `Date` keeps only milliseconds, which would repeat rows at batch boundaries (caught in review; a test pages with batches of one). Every column name states its basis.

| Report    | Rows and basis                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales     | One row per Dubai day of the range, from `sales_daily`. With `booked`: placed, cancelled, booked, net, delivery, total, AOV and cancellation rate, by order date. With `delivered`: delivered orders and amounts, by delivery date. With `collected`: cash by collection date. Each row has its `computed_at`. A day not computed says "not computed" and has no figures. |
| Orders    | One row per order line placed in the range: order number, Dubai time, current status, source, customer name and phone, area and emirate, and the product, brand and category as sold. Then SKU, quantity, unit price, line discount, line total, the order's amounts, coupon, payment and cash state. No address beyond the area.                                         |
| Products  | Per product, with brand and category as sold, for what was delivered in the range (by delivery date): units, orders, discount and net. Read from the orders themselves, so the order count is exact.                                                                                                                                                                      |
| Inventory | Snapshot of every variant of products not in the bin: brand, SKU, product status, active, stock, alert level, stock state, the product's total stock, and the snapshot time.                                                                                                                                                                                              |
| Customers | Snapshot of customers who ordered, grouped by phone: name, phone, orders placed and cancelled, booked spend (not cancelled) and delivered spend kept apart, first and last order, areas, and the snapshot time.                                                                                                                                                           |

**Personal data.** The orders and customers reports carry names and phones (`PERSONAL_DATA_REPORTS`), so both need `customers.export` as well as `reports.export`. This extends ADR 0076, where only the customers report needed it.

**Download.** `GET /v1/admin/reports/:id/download` (`reports.export`) serves a `stream` job:

- **Checks, in one repeatable-read snapshot:** the job is the caller's own (otherwise 404, as for an unknown ID); the caller still holds every one of the job's `required_permissions` (otherwise 403); the job is `ready` and not expired (otherwise 409 `REPORT_NOT_AVAILABLE`, which file jobs also get until step 112).
- **Size:** the rows come from the same snapshot. More than 20,000 data rows (four times the stream limit) gives 409 `REPORT_TOO_LARGE`.
- **Audit:** a `report.downloaded` entry, with the row count and whether the report holds personal data, is committed before the response is sent. If the audit fails, nothing is sent.
- **Response:** `text/csv; charset=utf-8`, `attachment` with a file name that names the report, basis and range (or the snapshot day), `private, no-store` and `nosniff`.

## Alternatives considered

- **Leave phone numbers unprefixed so they stay numeric.** The cost of prefixing: a phone re-imported elsewhere starts with an apostrophe in the raw file. A leading `+` is exactly what a formula needs. A defused phone is still readable, so this was rejected.
- **Products from the daily table.** That table has no order counts; the orders themselves give exact counts, and the range is bounded. Rejected.

## Consequences

- Step 112 reuses `reportRows` to build `file` jobs into private storage, signs download links (15 minutes), cleans up expired files, and adds the Reports UI.
- A column change is a change to the report: note it in this ADR, because the client may have spreadsheets built on these columns.
