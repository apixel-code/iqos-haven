# 0075 — Owner analytics: sales, products, brands, search and saved lists

- Date: 2026-10-16
- Status: accepted
- Step(s): 109

## Context

Roadmap step 109 asks for the Owner's financial, search and saved-list dashboards: AOV, cancellation, status, product, brand, search, no-result and saved-list views, with no fake chart values. Architecture §14 defines the measures. ADR 0071 fixes their meaning, ADR 0072 adds the daily tables and ADR 0073 their freshness. The prototype (`VIEWS.analytics`) has five tabs: Overview, Sales, Products & brands, Search and Wishlist. It also has date presets, filters by product, brand, category and status, and demo series.

## Decision

**One route.** `GET /v1/admin/analytics?from&to` (`dashboard.financial_read`, checked again inside the read; `private, no-store`) calls `readAnalytics`. The range is at most 366 Dubai days and must be real dates; an unknown field is refused. Everything is read in one repeatable-read snapshot, from the daily tables:

- **Freshness:** the days computed, the days not computed (listed, never counted as zero), and the oldest and newest `computedAt`.
- **Totals:** placed orders; booked (orders, net, delivery, total, AOV); cancelled (orders, total, rate in basis points); delivered (same fields as booked); collected (orders, cash, AOV). AOV is integer fils rounded half-up, and rates are basis points.
- **Previous period:** the same number of days just before `from`, read the same way, with its own count of missing days.
- **Per day:** placed, cancelled, booked, delivered and collected.
- **Status mix:** orders placed in the range by their status now. This is the only part read live from `orders`.
- **Products:** the top 20 by delivered net, then by units ordered, with the share of delivered net.
- **Brands:** the top 20 by the brand name snapshotted on each sale.
- **Search:** totals and the no-result rate; searches whose term was not kept, counted only; the top 20 terms; the top 20 no-result terms; searches per day.
- **Saved lists:** adds and removes; the top 20 products with whether they are out of stock now. The figures are device activity, not customers.

**UI.** Analytics (Owner only, both in the API and in the navigation) has the five tabs, presets for the last 7, 30 and 90 days, and a custom range. A note names the days not computed and points to the backfill. Comparison with the previous period is shown only when that period has figures.

- **Charts:** single-series columns in the accent color, one slot per day of the range. A day not computed gets a gray mark on the baseline. A focused or hovered column reads out its value. The Sales tab carries every figure as a table.
- **Status:** shown as a proportional bar in the status colors, with a labelled legend that gives each count.

**Left out:**

- **Prototype filters by product, brand, category and status:** the daily tables are not keyed by category or status.
- **Weekly/monthly grouping and hourly views:** the rows are per day.
- **The prototype's synonym hints and restock suggestions:** there is no data behind them. The UI states only "saved but out of stock".
- **CSV export:** this belongs to reports, steps 110–111.

## Consequences

- The answer is bounded: ≤366 day rows and ≤20 rows per ranking.
- Long ranges depend on the backfill (`pnpm analytics:backfill`, ADR 0073), and the page says so.
- Freshness is taken from `sales_daily`. A backfill run with `--parts` that leaves out products, search or saved lists can leave those sections covering fewer days than the headline; run the backfill with all parts (the default).
- Adding category or status breakdowns would need new daily tables or a live read; that is a separate scope decision.
