# apps/worker — BullMQ, outbox relay, reconciler, scheduler

- DB is the source of truth; Redis jobs are disposable. Anything lost in Redis must be recoverable by the reconciler from `outbox_events` / `consumer_effects`.
- Queue Redis policy `noeviction`. Bounded concurrency. Clean shutdown (finish or release leases).
- Relay: short leases, `FOR UPDATE SKIP LOCKED`, stable job IDs = event/effect IDs. Never hold a DB transaction across a network call.
- Consumers must be idempotent: unique effect key; DB side-effect + effect completion in the same transaction.
- External sends (email) disabled by default in tests/staging unless explicitly enabled; Mailpit locally.
- Scheduled jobs use `scheduled_runs` slot uniqueness and catch up missed slots.
- Log event ID / effect key / attempt, never payload PII.
