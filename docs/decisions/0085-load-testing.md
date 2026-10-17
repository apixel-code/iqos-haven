# 0085 — Representative load, query and payload testing

- Date: 2026-10-17
- Status: accepted (targets evaluated against Apixel's scenario until BI-16 is answered)
- Step(s): 121 (follows ADRs 0036, 0044 and step 119's budget profile)

## Context

Step 121 asks for a defined dataset and concurrency, measured API and checkout p95, pool and lock waits, and the architecture's performance targets evaluated. Those targets are read p95 < 300 ms and checkout p95 < 800 ms "under an agreed concurrent-load scenario". Architecture §16 also asks for browsing mixed with checkout, simultaneous last-unit and coupon requests, and a queue outage with recovery, recorded as dataset, concurrency, duration and p95. No traffic figure has been agreed with the client.

## Decision

- **One repeatable script, `pnpm load:test`** (`scripts/load/load-test.cjs`):
  - **Dataset:** seeds a launch-sized catalogue on a fresh schema of the test database.
  - **Server:** runs the built API on the budget profile in its own process (`scripts/load/api-server.cjs`, with the worker's relay, consumers and reconciler).
  - **Phases:** history, mixed load, contention and a queue outage.
  - **Measures:** per-route p50/p95/p99, the API pool (open, idle, waiting) and PostgreSQL lock waits; it captures the plan of every statement over 100 ms with `auto_explain`, which is enabled on the test database for the run only and reset afterwards.
  - **Output:** `load-results.json`. Every request has a 30 s timeout; a 20-minute watchdog stops a stuck run and still cleans up.
- **Apixel's scenario**, recorded as BI-16 for the client to confirm or replace: 50 shoppers browsing with 0.5–2 s pauses, 8% checking out, 2 staff; and a 150-shopper stress run. Results and plans are in `docs/load-report.md`.
- **Volume check** of the admin and rollup reads at 51,788 orders, with their plans.

## What it found, and the fixes

- **Targets:** met by a wide margin (read p95 32 ms, checkout p95 62 ms; 23 and 54 ms at 150 shoppers). No pool waits.
- **Correctness:** last units and the one-use coupon stay exact under contention; the ledger reconciles; effects drain within seconds of Redis returning.
- **Admin orders list (fixed):** it grouped every order with its lines before the page limit, so its cost grew with the order history. It now picks the page from the `orders_created` index and counts lines per row (52 ms → 2 ms at 51,788 orders).
- **Harness (fixed):** the API's Nest shutdown hooks ended `check-gate-e2e.cjs --serve` on SIGTERM before its cleanup ran. That left storefront servers, gateway containers and schemas behind, and the leftovers had pushed this machine's load average to 394 during the first measurements. The harness now removes those hooks (it closes the app itself), stops the storefront's whole process group, and reports a gateway it could not stop. All measurements in the report were taken again on a quiet machine.
- **Watch items:** search by order number or phone and the delayed filter scan open or all orders. They are within target now. The remedy is named in the report for when the history grows tenfold.

## Consequences

- The targets hold for the proposed scenario on the budget profile, with headroom. The same script reruns on staging and with the client's figure (`--shoppers`, `--seconds`).
- Browser-side targets (LCP, CLS, first-load JS) stay with step 120's real-device part.
