# 0074 — Operational home dashboard

- Date: 2026-10-16
- Status: accepted
- Step(s): 108

## Context

Roadmap step 108 asks for an operational home dashboard with pending orders, low stock and alerts. Staff must get only the operational data they are permitted to see. The prototype dashboard (`VIEWS.dashboard`) shows an attention bar, KPI tiles, recent orders, a list of what needs attention, low stock and best sellers. The Owner's version adds revenue, AOV and a sales chart. Its numbers come from demo data. The Owner's financial and analytics dashboards are step 109.

## Decision

**One route.** `GET /v1/admin/dashboard` (`@Authenticated()`, `private, no-store`) calls `readAdminDashboard`. That function runs one repeatable-read snapshot, which reads the caller's rights and then only the sections those rights allow. A section the caller may not see is `null` and is never queried. A right withdrawn shows up on the next request.

| Section       | Needs                      | Content                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders`      | `orders.read`              | Open counts per state; delayed count; orders placed today and yesterday up to the same time; up to 5 pending or delayed open orders, oldest first; the 7 newest orders. Each order line has its number, state, time, delayed flag and total. The customer's name is shown only with `customers.read`; the phone and address are never shown. |
| `stock`       | `inventory.read`           | Low and out counts, plus up to 5 lowest variants that are active and on published products, at or below their alert level.                                                                                                                                                                                                                   |
| `reviews`     | `reviews.moderate`         | Pending reviews count.                                                                                                                                                                                                                                                                                                                       |
| `topProducts` | `orders.read`              | Up to 5 products by units ordered over the last 7 Dubai days, from `product_sales_daily` (up to about 10 minutes behind, ADR 0073). The net amount is shown only with `dashboard.financial_read`.                                                                                                                                            |
| `sales`       | `dashboard.financial_read` | Booked sales for today and yesterday from `sales_daily`: orders, total, AOV, cancelled, and the `computedAt` freshness. A day not computed yet is `null`, shown as "Not computed yet", never as zero. The tax note is included.                                                                                                              |

**Delayed.** An order is delayed when it has been Pending for more than 2 hours, or Confirmed/Processing for more than 3 hours, since it was placed. These are the prototype's limits, kept in `DELAYED_AFTER_MINUTES`; the client may change them (BI-14).

**UI.** The workspace home shows the dashboard above the section cards. It refreshes every minute and on demand. Every figure comes from the route; a `null` section is not drawn. The prototype's revenue chart, period comparison, quick confirm and brand ranking are left out: the chart and brands belong to step 109, and quick confirm needs the versioned transition flow of the order screen.

## Consequences

- Staff see order totals because their order screens already show them. Day sales, AOV and product amounts stay Owner-only, and the API enforces this.
- Step 109 adds the financial and analytics dashboards that use date ranges, built on the same daily tables.
