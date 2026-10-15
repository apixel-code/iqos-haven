# 0060 — Low-stock inbox and email, quiet window, daily-summary slot

- Date: 2026-10-15
- Status: accepted
- Step(s): 92 (daily-summary metrics: 106)

## Context

Roadmap step 92: low-stock email and bell, daily-summary registration and operations acceptance; "no repeated low-stock spam". ADR 0023 emits `inventory.low` once per crossing from above the alert level to at or below it, and re-arms when stock rises above it; it left the consumers and their backfill decision to this step. Architecture §8 asks for a 09:00 Asia/Dubai daily summary with one run per slot across replicas. The summary's figures need the daily rollups of step 106. The prototype's notification settings have one recipient list and separate switches for new-order, low-stock and daily-summary email.

## Decision

**`inventory.low` now requires `notification` and `email`.** No backfill: events written before this step keep their empty consumer set. Nothing has been deployed, and the admin inventory list already shows every low variant.

**Decide at delivery, from current data.** Both consumers alert only while the variant is still at or below its alert level, is active, and belongs to a published, untrashed product. If the variant was restocked before the worker reached the event, or the product is a draft, the effect completes without sending anything. The wording uses the stock level at delivery ("2 left", "Out of stock"), never the payload.

**Quiet window, 24 hours per variant and channel.** Table `low_stock_alerts (variant_id, channel)` holds the event that last alerted and when. A single upsert claims the alert:

- A first alert claims it.
- The same event claims it again, so a retry or redelivery still completes.
- A different event claims it only when the window has passed.

The upsert locks the row, so two crossings handled at once alert only once. The inbox claim commits with the notification and the effect. The email claim commits before the send, outside any transaction. A send that dies permanently therefore still holds the window: a dead effect is investigated, and a second alert within the day is not needed. There is also an accepted loss: a send that keeps failing for more than 24 hours can have its claim taken by a later crossing, and its retry then completes as "quiet". The later crossing's email replaces it. When the inbox is off or the email is switched off, nothing is claimed.

**Inbox.** Type `inventory.low`, title "Low stock: <product>", body "<SKU> · <level> (alert level N)", link `/inventory/<variant id>` (the bell opens Inventory). One receipt for each active staff user holding `notifications.read_own` and `inventory.read`. `NOTIFICATION_TYPE_PERMISSIONS` re-checks `inventory.read` when the inbox is read. `inApp = false` writes nothing.

**Email.** Template `inventory.low` v1: product, SKU, level and alert level. It has no link and no customer data. It goes to the same recipient list as the new-order email, only while `notifications.lowStockEmail` is true. The field is optional, so settings saved earlier read as off. Turning it on requires at least one recipient (contract refine). Sending still needs BI-07 and `EMAIL_SEND_ENABLED`, as in ADR 0047.

**Daily summary.** The worker registers `reports.daily_summary` (09:00 Asia/Dubai, `catchUp: 1`) on the durable scheduler, so each day has exactly one slot across replicas. Until step 106, a run completes its slot and logs `awaiting_analytics`. It sends nothing, invents no figures and has no settings switch. Step 106 adds the preference, recipients and content. It does not replay the slots completed before that, because `catchUp: 1` never back-fills past days.

## Alternatives considered

- **Rely on the crossing rule alone.** Rejected: a variant whose stock moves around its alert level (a cancellation followed by a new order) re-arms and alerts on every bounce.
- **A cooldown column on `variants`.** Rejected: writing it would take the variant lock used by checkout and stock commands, just to record an alert.
- **Alert from the event payload.** Rejected: it would report a level that may no longer be true when the alert is read.

## Consequences

- A variant alerts each channel at most once every 24 hours, even if it crosses again. The Inventory "Low" filter remains the complete view.
- The low-stock email shares the new-order recipient list. Separate lists would need a settings change.
- `low_stock_alerts` holds one row per variant and channel; it does not grow with alerts.
- M8 operations acceptance: `apps/worker/src/operations-gate.int.test.ts` covers a store order from the real order transaction, the inbox and email, one low-stock alert, Pending → Delivered by staff with `codStatus` still pending, and then a separate cash collection command and its replay.
