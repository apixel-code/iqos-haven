# 0059 — Staff inbox, read receipts and the admin event stream

- Date: 2026-10-15
- Status: accepted
- Step(s): 91

## Context

Roadmap step 91: per-user inbox, read receipts and SSE. Done condition: durable inbox; own read flags; reconnect, gap and refetch handled; no proxy buffering; revocation closes the stream. Architecture §8 "Notification inbox" and "SSE". The tables and the first notification type (`order.new`) exist (ADR 0047). The budget profile runs one API process and no cache Redis.

## Decision

**Inbox** (`notifications.read_own`, `private, no-store`):

- `GET /v1/admin/notifications?limit&after&unread`: the user's own receipts, newest first by notification ID (UUIDv7, time-ordered), with the unread count.
- `POST /v1/admin/notifications/:id/read`: sets that user's `read_at` once; reading again returns the first time; a notification without a receipt for this user is 404.
- `POST /v1/admin/notifications/read-all` with `upTo`: marks the user's unread notifications up to the newest one they have seen.
- **Permissions are checked again on every read.** A receipt records who was eligible when the notification was written; a type also needs its permission now (`order.new` → `orders.read`), otherwise it is hidden and cannot be marked.

**Event stream.** `GET /v1/admin/events/stream` (`notifications.read_own`), through the existing gateway route that never buffers (`flush_interval -1`), with `Cache-Control: no-store` and `X-Accel-Buffering: no`.

- The database is the authority. The stream checks the user's inbox every 2 s and sends `event: notification` with the notification ID as the event ID and only `{id, type}` as data; the browser reads the content from the inbox, with its permissions. No pub/sub is needed on one API process; with replicas each process polls the same database, so nothing is missed.
- On connect the browser gets `event: ready`. With `Last-Event-ID` the stream sends every notification after that ID (gap fill); without it, it starts at the newest notification and the browser reads the inbox itself. Duplicates are harmless: the browser refetches.
- Heartbeat comment every 20 s. The session is checked every 10 s without refreshing it (`sessionStillValid`): revoked, expired, idle or deactivated → `event: signed-out` and the stream ends. Every stream ends after 30 minutes (`event: reconnect`) and the browser reconnects through authentication.
- At most 5 streams per user (429) and 200 per process (503), counted before any database call; with replicas the cap is per process. A client that stops reading (more than 64 KB waiting) is disconnected. Shutting the API down ends every stream with `event: reconnect`.

**Admin.** A "Notifications" button with the unread count in the header, a list with "Mark read" and "Mark all read", and an `EventSource` that refetches the inbox on `ready` and `notification`, plus a slow 2-minute poll as a fallback. `signed-out` sends the browser to sign in.

## Consequences

- An idle tab with an open stream does not keep the session alive: the stream never refreshes it.
- Database load: one small indexed query per open stream every 2 s, bounded by the connection limits.
- New notification types add their permission to `NOTIFICATION_TYPE_PERMISSIONS`.
