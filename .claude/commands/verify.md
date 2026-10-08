---
description: Verify the foundation without hiding command failures
---

Run `pnpm verify`. It stops on the actual failing command; do not pipe the command to `tail` and mistake the pipeline's successful tail status for a passing test. Capture output to a temporary file if needed, retain the exit status, then inspect only relevant failure lines.

For DB/transaction/order/stock/coupon/idempotency/auth/age-boundary work, inspect `docker compose ps` and run `pnpm test:int` against a dedicated test database. If infrastructure is unavailable, say NOT RUN with the reason; do not count it as PASS.

Report PASS/FAIL/NOT RUN per relevant check, and only actionable failure details. A green foundation suite does not close a business feature acceptance or milestone gate. Never paste secrets or full SQL/error logs.
