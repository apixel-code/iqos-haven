# 0072 — Daily aggregate tables and idempotent rollups

- Date: 2026-10-16
- Status: accepted
- Step(s): 106 (scheduling, recent days and backfill: 107)

## Context

Roadmap step 106 has these done conditions:

- Recompute and upsert by day.
- Historical brand snapshots.
- A retry does not add twice.

Architecture §5 lists `sales_daily`, `product_sales_daily`, `search_daily` and `wishlist_daily`. The step 105 definitions (ADR 0071) decide what each figure means. Order events already carried `analytics_rollup: 106` as a planned consumer.

## Decision

**Tables** (migration `20261016000200_daily_aggregates`). The key is a Dubai `day`, and every amount is integer fils with non-negative checks.

| Table                 | Content                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales_daily`         | Per day: placed, cancelled and booked orders; booked net, delivery and total; cancelled total; delivered orders, net, delivery and total; collected orders and cash; the definition version. A check enforces placed = booked + cancelled.                        |
| `product_sales_daily` | Per day, product and brand name **as snapshotted on the order item**, so a later brand change never moves past sales. Ordered units and net come from orders placed that day and not cancelled; delivered units, net and discount from orders delivered that day. |
| `search_daily`        | Per day and normalized term: searches, zero-result searches and the result total. `''` holds the terms not kept (ADR 0069).                                                                                                                                       |
| `wishlist_daily`      | Per day and product: adds and removes, for products that still exist.                                                                                                                                                                                             |

Indexes were added on `orders(delivered_at)` and `order_collection_records(collected_at)`.

**Rollup.** `rollupDay(db, day)` and `rollupDayIn(tx, day)` recompute one day from the authoritative tables and replace that day's rows whole:

- `sales_daily` is upserted; the other three tables have the day's rows deleted and inserted again.
- The sales figures come from the same `financialTotals` helper as the Owner's summary, so the two cannot drift apart.
- A per-day `pg_advisory_xact_lock` makes recomputes of one day take turns. Running the same day again, or several times at once, gives identical rows.
- It runs in Read Committed: each query after the lock sees the latest committed rows. A commit that lands between two of its queries is repaired by that commit's own event.
- A day older than the raw-event retention (90 days) keeps its search and saved-list rows, because those totals cannot be rebuilt once the events are gone.

**Event consumer** `analytics_rollup` (worker, a database effect). It is added to `order.created`, `order.updated`, `order.status_changed`, `order.cancelled`, `order.collection_recorded` and `order.collection_corrected`. For the order in the event it recomputes the sales and product rows of every Dubai day the order touches: placed, delivered, and every collection record, so a correction leaves the old day too.

- Days are locked in date order, so two effects cannot deadlock.
- Order commands never take these locks; only analytics effects for the same day wait for each other.
- **No backfill:** events written before this step keep their consumer sets. Step 107 recomputes recent days on a schedule and adds a controlled historical backfill. Until then, a missing row means "not computed", not zero.

The search and saved-list tables are filled by the scheduled pass in step 107, and in tests by `rollupDay`.

## Consequences

- Dashboards (step 109) and reports (step 111) read these tables for long ranges, and the live summary for today (step 107 freshness).
- The M7 and M8 gate tests now expect three effects on a new order: inbox, email and analytics.
