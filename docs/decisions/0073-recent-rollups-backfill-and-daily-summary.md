# 0073 — Recent-day rollups, historical backfill and the daily summary email

- Date: 2026-10-16
- Status: accepted
- Step(s): 107 (builds on ADR 0060 and 0072)

## Context

Roadmap step 107 has three done conditions:

- Recent days are recomputed.
- Each schedule slot runs once.
- Only permissioned staff receive the summary.

Architecture §14 asks for recent-day recomputes to catch late edits, a controlled historical backfill, and today's figures with their freshness shown. Architecture §8 asks for a 09:00 Asia/Dubai summary that retries and configuration changes never send twice for the same slot. ADR 0072 left the search and saved-list tables, and orders written before its consumer, to this step. ADR 0060 registered the summary slot and left its content and recipients to this step.

## Decision

**Scheduled recomputes.** Both jobs run on the durable scheduler (`scheduled_runs`, one run per job and slot across replicas, `catchUp: 1`):

- `analytics.rollup_today` runs every 10 minutes and recomputes yesterday and today, all four parts. Yesterday is included so its last minutes are counted once the day closes.
- `analytics.rollup_recent` runs at 03:00 Dubai and recomputes the seven days before today (`LATE_EDIT_DAYS`). It covers orders whose events predate the analytics consumer, and any effect that died.

A recompute replaces a day's rows (ADR 0072), so a repeated slot adds nothing.

**Freshness.** `readSalesDays(db, from, to)` returns each day's `sales_daily` row with its `computedAt`, plus the days that have no row (`missing`, meaning not computed, not zero). The dashboards (step 109) show `computedAt`. The summary email also states when its figures were computed.

**Historical backfill.** Run `pnpm analytics:backfill --from YYYY-MM-DD --to YYYY-MM-DD [--parts …]` (worker CLI, runtime database URL only). It calls `backfillRollups`, which recomputes at most 366 days, never a day after today, oldest first. Each day gets its own short transaction, so Ctrl-C stops after the current day and every finished day is complete. Days older than the 90-day event retention keep their search and saved-list rows. The command prints days only, and never an error's details.

**Daily summary.**

- At 09:00 Dubai the job recomputes the previous day. It then calls `emitDailySummary(db, day)`, which writes one `report.daily_summary` event (aggregate `report`, ID = the day, consumer `email`).
- A per-day advisory lock makes writers take turns; a later writer finds the existing event and adds nothing. The partial unique index `outbox_events_one_daily_summary` (migration `20261016000300`) is the database backstop. A reclaimed slot, a second replica or a manual rerun therefore cannot queue a second summary for that day. Resending means a deliberate replay of that event.
- The email planner decides at send time. It sends nothing unless the Owner switched on `dailySummaryEmail` (Settings → Notifications; optional, so stored values read as off). The recipients are the addresses on the Settings list that belong to active staff accounts that hold `dashboard.financial_read` now. Any other address on the list, a deactivated account's address, or the address of staff without that right receives nothing.
- The planner recomputes the day before reading it, in its own transaction, outside any network call.
- The message gives booked, cancelled, delivered and collected figures, each with its date basis. Amounts are formatted from integer fils. It names up to five products by units ordered, and carries the tax note and the computation time. It contains no order numbers, customers or links.
- Real sending still waits for BI-07, the verified sending domain.

## Alternatives considered

- **Send to every address on the Settings list.** Revenue would reach mailboxes that have no right to it in the admin, so this was rejected.
- **A separate sends table keyed by slot and recipient.** The event unique per day, plus the email delivery key (event, template, recipients), already gives one message per day. A recipient change between retries can change the delivery key; that is accepted, as for the other emails.
- **Recompute every day nightly.** The cost grows without bound, and days past the retention cannot be rebuilt in full, so only recent days run on a schedule and older days need an explicit backfill.

## Consequences

- Dashboards and reports (steps 109–111) read the daily tables together with `computedAt`. Today's figures can be up to about 10 minutes old, and change commands refresh them sooner through the order events.
- No summary was sent for slots before this step. `catchUp: 1` does not replay them.
