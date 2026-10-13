# 0047 — New-order inbox notification and email

- Date: 2026-10-13
- Status: accepted
- Step(s): 78 (inbox API, read receipts and SSE: 91; low-stock and other notifications: later steps)

## Context

Roadmap step 78: the first handlers for `order.created`, wired before real checkout is switched on. An order must be accepted without depending on email. Architecture §8 "Notification inbox": immutable content once, one receipt per eligible recipient, a read flag per user. BI-07: the provider is Resend; new-order email goes to the address the Owner enters under Settings → Notifications; a verified sending domain and sender address are still missing.

## Decision

**Tables (migration `20261013000100_notifications`).**

- `notifications`: one row per `(source_event_id, type)`, with a title, a body and an admin path. Never updated or deleted (trigger). `source_event_id` is not a foreign key, because completed outbox events are pruned and a notification must outlive them. `link` must be a path, never an absolute URL.
- `notification_receipts`: one row per `(notification_id, user_id)`, `delivered_at`, `read_at`. Only `read_at` may change, once, from empty to a time; no delete. Index `(user_id, read_at, notification_id)` for the inbox.

**`order.created` now requires two consumers: `notification` and `email`.** Both effects are written in the order transaction as rows only; the worker handles them after commit. No backfill: order submission has never been switched on, so the only earlier `order.created` events are in development and test databases, and they keep the empty consumer set they were written with.

**Inbox consumer (`notification`, database handler).** In the transaction that completes the effect, `writeNewOrderNotification` inserts the notification ("New order IH-001001", "3 items · AED 165.00 · <area>", link `/orders/<id>`) and one receipt for every active staff user whose role holds both `notifications.read_own` and `orders.read`. A redelivery keeps the content as first written, keeps every existing receipt and its read state, and adds a receipt only for someone who became eligible since. `notifications.inApp = false` writes nothing and completes. With nothing configured the inbox is on.

**Email consumer (`email`, planner `order.created`).** Template `order.new` v1: order number, total, item count and area, and "sign in to the admin". Recipients are `notifications.newOrderEmail.recipients`, and only while `enabled` is true; otherwise the effect completes with `no-recipients` and nothing is sent. With nothing configured the email is off. Delivery uses the existing email consumer: delivery key from event, template and recipients (Resend idempotency), `EMAIL_SEND_ENABLED`, and the staging allowlist.

**No personal data leaves the order.** The notification and the email carry no customer name, phone or address and no link that grants access. Staff open the order in the admin, where permissions apply. The email has no link at all: the worker has no admin-origin setting, and the message goes to a mailbox outside the system.

**Failure handling.** An event whose order does not exist (orders are never deleted) or whose payload is wrong goes to `dead` with a code, not to retry. An email provider failure retries on the email effect alone; the inbox entry and the order are unaffected.

**Runtime rights.** The runtime role can insert and read both tables and update only `notification_receipts.read_at`. Nothing can update or delete a notification or delete a receipt, the migration role included.

## Consequences

- The inbox is kept without limit for now. Pruning old notifications needs a later migration that adds a retention rule to the two triggers (retention defaults: BI-08).
- A receipt is a snapshot, so the inbox API (step 91) must check `orders.read` again before it shows a new-order notification to someone whose role changed.

- Recipients are a snapshot: someone who gains the role later does not see older notifications; someone deactivated keeps receipts they can no longer read.
- Switching the inbox off drops notifications for orders placed while it is off; they are not created later.
- The Owner changing the recipient list between a failed send and its retry sends to the new list under a new delivery key.
- Real email still needs a verified sending domain and sender address (BI-07) and `EMAIL_SEND_ENABLED=true`; staging also needs the address in `EMAIL_RECIPIENT_ALLOWLIST`.
- Wording is neutral placeholder copy until the client approves it (BI-01).

## Not built here

- Reading the inbox, marking as read, the bell and SSE (step 91). Nothing shows these rows in the admin yet.
- Low-stock notifications, the daily summary, customer-facing messages.
