# Runbooks — which one, when

Every runbook names commands that exist in this repository (root `package.json`). On the VPS the services run under Docker Compose (step 122); `docker compose ps` / `logs <service>` are the first look. Record incident notes with UTC times, alert names, request/event/effect IDs and counts only: never customer data, passwords, tokens, links or raw SQL.

| Situation                                                            | Runbook                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| An ops alert email (`effects.*`, `redis.queue`, `checkout.errors`…)  | [incident-and-queue-recovery.md](incident-and-queue-recovery.md)                     |
| Queue Redis lost, worker crashed, dead background effects            | [incident-and-queue-recovery.md](incident-and-queue-recovery.md)                     |
| Order/reset/invitation emails not arriving, provider outage, bounces | [email-delivery.md](email-delivery.md)                                               |
| Image uploads stuck, rejected or missing                             | [uploads-and-media.md](uploads-and-media.md)                                         |
| A staff account or an Owner is compromised or locked out             | [staff-and-owner-recovery.md](staff-and-owner-recovery.md)                           |
| A key or credential leaked; planned rotation                         | [secrets-and-keys.md](secrets-and-keys.md), [age-ticket-keys.md](age-ticket-keys.md) |
| A release went wrong                                                 | [deploy-and-rollback.md](deploy-and-rollback.md)                                     |
| Staging server: setup, release, operator commands                    | [staging.md](staging.md)                                                             |
| Production go-live on the VPS (domain day)                           | [production.md](production.md)                                                       |
| Data loss, restore drill                                             | [backup-and-restore.md](backup-and-restore.md)                                       |
| First Owner, launch settings and catalogue                           | [owner-and-data-bootstrap.md](owner-and-data-bootstrap.md)                           |

## Operator commands

| Command                                                         | What it does                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm launch:check`                                             | Read-only readiness: migrations, Owner, settings, catalogue, ledger, dead effects |
| `pnpm ops:effects`                                              | Lists dead background effects (ID, consumer, error code)                          |
| `pnpm ops:effects --replay <id> --reason "<incident: fix>"`     | Puts one dead effect back to pending, audited                                     |
| `pnpm ops:test-alert`                                           | Sends one test alert to `OPS_ALERT_RECIPIENTS`                                    |
| `pnpm ops:owner-recovery --email <owner> --reason "<incident>"` | Break-glass: restores an Owner account's sign-in, signs it out everywhere         |
| `pnpm ops:backup` / `pnpm ops:restore-drill <set>`              | Encrypted backup set / isolated, measured restore                                 |
| `pnpm age:keygen [kid]`                                         | New age-ticket key pair                                                           |

`ops:effects` and `ops:owner-recovery` use `DATABASE_URL` (the runtime role); the backup commands use `DATABASE_MIGRATION_URL`. Run them on the server, never from a laptop against production.
