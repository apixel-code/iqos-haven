# Load, query and payload report — roadmap step 121

- Date: 2026-10-17 (local). Decision record: ADR 0085. Script: `pnpm load:test` (`scripts/load/`).
- **Host:** Apple M2 (8 cores) with local Docker PostgreSQL 18 and Redis. This is a developer machine, not the production VPS (BI-06), so the absolute numbers are indicative. Rerun on staging before launch (step 122 onwards).
- **Profile:** budget (one API process, in-process catalogue cache, local limiters, pool of 10 connections). The worker's relay, consumers and reconciler run with production settings.

## Scenario

The architecture targets apply "under an agreed concurrent-load scenario"; none is agreed yet (**BI-16**). Apixel's proposal, measured here:

| Item         | Value                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Catalogue    | 30 brands, 6 categories, 600 products (540 published), 1,800 options, 40 delivery areas                |
| History      | 600 orders placed through the real checkout before measuring                                           |
| Shoppers     | 50 at once, 120 s. Each journey: home, listing, search, product, cart, each step after a 0.5–2 s pause |
| Checkout     | 8% of journeys quote and place an order (single attempt key, one to three lines, some coupons)         |
| Staff        | 2 at once: orders list, an order, dashboard, customers, low stock, every 2 s                           |
| Stress       | The same with 150 shoppers for 90 s                                                                    |
| Contention   | 20 simultaneous orders for the last 3 units; 10 simultaneous orders with a one-use coupon              |
| Queue outage | Queue Redis stopped for 20 s while 4 shoppers keep checking out, then started again                    |

With 0.5–2 s pauses, 50 shoppers produce about 25 API reads a second. That matches several hundred real visitors, who pause longer than this.

## Targets (architecture §15)

| Target                   | Budget | 50 shoppers | 150 shoppers |
| ------------------------ | ------ | ----------- | ------------ |
| Read API p95 (all store) | 300 ms | **32 ms**   | **23 ms**    |
| Checkout order p95       | 800 ms | **62 ms**   | **54 ms**    |

Both pass by a wide margin. Storefront LCP/CLS and first-load JavaScript are browser-side targets. They need the mid-range Android profile on staging (step 120 and BI-15) and are not measured here.

## Routes during the mixed load (50 shoppers, ms)

| Route             | Count | p50 | p95 | p99 | Max | Errors |
| ----------------- | ----- | --- | --- | --- | --- | ------ |
| store: home       | 904   | 2   | 22  | 23  | 24  | 0      |
| store: listing    | 904   | 3   | 6   | 10  | 15  | 0      |
| store: search     | 904   | 24  | 47  | 62  | 160 | 0      |
| store: product    | 904   | 8   | 20  | 27  | 155 | 0      |
| store: cart lines | 904   | 5   | 11  | 16  | 45  | 0      |
| checkout: quote   | 357   | 8   | 16  | 22  | 31  | 0      |
| checkout: order   | 357   | 35  | 62  | 105 | 442 | 0      |
| admin: orders     | 118   | 9   | 17  | 59  | 59  | 0      |
| admin: order      | 118   | 14  | 40  | 42  | 48  | 0      |
| admin: dashboard  | 118   | 15  | 27  | 34  | 34  | 0      |
| admin: customers  | 118   | 5   | 9   | 16  | 17  | 0      |
| admin: inventory  | 118   | 3   | 6   | 15  | 15  | 0      |

At 150 shoppers (2,066 journeys, 831 orders) every p95 stayed at or below 40 ms (checkout order 54 ms, max 126 ms). Search is the most expensive read, as expected for full-text plus trigram matching.

## Pool and locks

| Measure (sampled every 0.5 s)      | 50 shoppers      | 150 shoppers     |
| ---------------------------------- | ---------------- | ---------------- |
| API pool requests waiting          | max 0            | max 0            |
| API pool connections open          | max 6 of 10      | max 8 of 10      |
| Sessions waiting on a lock         | max 3, mean 0.22 | max 2, mean 0.14 |
| Sessions idle inside a transaction | max 6, mean 1.2  | max 4, mean 1.0  |

No request waited for a connection. The lock waits are the designed row locks of order creation (customer, coupon, variants, in the fixed order). "Idle in transaction" means time between statements of an interactive transaction; no network call happens inside one (invariant).

## Correctness under load

- **Last units:** 20 simultaneous orders for 3 units: exactly 3 placed (201), 17 refused (409), stock 0.
- **One-use coupon:** 10 simultaneous orders: exactly 1 placed, 9 refused, 1 redemption.
- **Queue outage:** about 220 orders placed while Redis was down, all answered normally (order p95 58 ms). Every inbox, email and rollup effect completed 6 s after Redis returned. A job that Redis loses at the instant it stops is re-enqueued by the reconciler, after at most about 6 minutes (stale after 5 minutes, a pass each minute).
- **Ledger:** stock reconciliation has 0 mismatches after every run.

## Query plans

- **During the load runs:** `auto_explain` (threshold 100 ms) caught no statement.
- **At volume:** a separate check grew the order history to **51,788 orders and 100,067 lines over 365 days**, timed the real read functions and captured plans over 30 ms. The results:

| Read (51,788 orders)          | p50 | p95 |
| ----------------------------- | --- | --- |
| Admin orders, first page      | 2   | 10  |
| Admin orders, delivered       | 2   | 4   |
| Admin orders, delayed         | 24  | 31  |
| Admin orders, by order number | 45  | 93  |
| Admin orders, by phone        | 45  | 55  |
| Dashboard                     | 28  | 36  |
| Customers, first page         | 9   | 10  |
| Customer with 121 orders      | 5   | 8   |
| Daily rollup of one day       | 26  | 51  |

**Fixed:** the admin orders list joined and grouped every order with its lines before the `LIMIT`. Its plan was a merge join over 100,067 lines, a group over 51,788 orders, then a top-N sort, so the first page cost grew with the whole history (52 ms here). The item count is now a subquery per order of the page, and the page comes from the `orders_created` index: 2 ms.

**Watch items (within target, they grow with history):**

- **Search by order number or phone** (about 45 ms) scans `orders`, because the filter is "order number OR name OR phone digits".
- **The delayed filter** (24 ms) evaluates its time rule per open order.

At ten times this history both would approach 300–500 ms. The remedy, when needed: answer an exact order number from its unique index first, and add a trigram index on the name and phone digits.

## Not covered

- The production VPS and its network (staging, step 122). Rerun `pnpm load:test` there.
- Browser-side LCP/CLS/JS budget on the agreed device profile (BI-15).
- Traffic beyond 150 simultaneous shoppers, or a client figure (BI-16): rerun with `--shoppers`.
