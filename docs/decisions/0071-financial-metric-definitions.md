# 0071 — Financial metric definitions and the summary query

- Date: 2026-10-16
- Status: accepted
- Step(s): 105 (daily tables: 106; dashboards: 109; reports: 111)

## Context

Roadmap step 105 has this done condition: booked, delivered and collected are kept apart, with labels for the date basis, Asia/Dubai, AED and tax.

Architecture §14 defines the measures, and ADR 0036 says prices are final as entered, with no VAT or excise calculation. The order rows already hold everything needed:

- `created_at`, `delivered_at`, `status`;
- `merchandise_subtotal_fils`, `discount_fils`, `delivery_fee_fils`, `total_fils`;
- `cod_status`.

Cash collection is a series of `order_collection_records`, and the latest record is in effect (ADR 0055).

## Decision

**Definitions** are in `packages/domain/src/metrics.ts` as code, with `METRIC_DEFINITION_VERSION = 1`:

| Measure           | Definition                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booked            | Orders placed (`created_at`) on the Dubai days asked. "Active" (not cancelled now) is split from "cancelled". Merchandise net is items after discount; delivery and the order total are shown separately. |
| Delivered         | Orders that are Delivered, by `delivered_at`. Delivered is not collected.                                                                                                                                 |
| Collected         | Orders whose cash is collected (`cod_status = 'collected'`), by the latest collection record's `collected_at` and amount. A correction replaces the earlier record; it is never added to it.              |
| AOV               | The order total (collected: the cash amount) divided by the orders the basis counts, in integer fils rounded half-up. None when no order is counted.                                                      |
| Cancellation rate | Placement cohort: placed in the range and cancelled now, divided by placed in the range, in basis points rounded half-up.                                                                                 |
| Status mix        | Orders placed in the range by their current status.                                                                                                                                                       |

**Dates:** a range is `from`..`to`, inclusive Dubai calendar days (UTC+4, no daylight saving), at most 366 days. Impossible or reversed dates are refused.

**Money:** AED as integer fils, never floats. Every answer carries the currency, the timezone and the tax note: "Prices are final as entered and include any tax; no separate VAT or excise is calculated."

**Query:** `readFinancialSummary(db, actorId, { from, to })` requires `dashboard.financial_read`, which only the Owner holds. It checks that right inside the same repeatable-read snapshot it reads from, reads the authoritative tables, and returns `financialSummarySchema`. The range bounds are sent as explicit `timestamptz` values.

The collected amount is the cash recorded, which can legitimately differ from the order total. That difference is not shown yet; reconciliation views can add it later. There is no route yet: the dashboards in step 109 and the reports in step 111 use it, and the daily tables in step 106 serve long ranges.

## Consequences

- Product and brand measures arrive with `product_sales_daily` (step 106).
- If the client later needs tax shown separately, it is a new definition version, not a silent change.
