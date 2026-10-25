# Email delivery

Who gets email: new-order alerts (Settings → Notifications recipients), the daily summary, low-stock alerts, staff invitations and password resets. Ops alerts go straight to `OPS_ALERT_RECIPIENTS` (incident runbook). Customers get no email at launch. An order is committed whether or not its email is sent: email is a background effect, retried and never a reason to touch the order.

## Configuration (worker)

| Variable                    | Meaning                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `EMAIL_SEND_ENABLED`        | Sends only when exactly `true`. Otherwise each email effect completes as `disabled` and is **not** sent later |
| `EMAIL_PROVIDER`            | `resend` in production (ADR 0004); `smtp` for Mailpit locally                                                 |
| `EMAIL_FROM`                | `no-reply@iqoshaven.com` once the domain is verified (BI-07)                                                  |
| `RESEND_API_KEY`            | Secret store only                                                                                             |
| `EMAIL_RECIPIENT_ALLOWLIST` | Addresses or `@domains`; mandatory in staging so test data never reaches real people                          |

## Emails not arriving

1. Is it one email or all? Check Settings → Notifications (recipients, new-order alerts on) for the store emails; for an invitation or reset, the admin shows the link's expiry and the Owner can send a new one.
2. `pnpm ops:effects --consumer email`: a dead email effect names its error code.
3. Read the code:
   - `RETRY_EXHAUSTED:…` (provider 5xx, timeout, rate limit): the provider was down for the whole retry budget. Exception: `RETRY_EXHAUSTED:RESEND_401` or `_403` means the API key is wrong or revoked (rotate it, below). Check the provider's status page and the worker logs (`docker compose logs worker | grep effectId`), then replay.
   - `RESEND_400`/`404`/`405`/`422`, `RESEND_BAD_BODY`, `SMTP_REJECTED`: configuration (key revoked, sender domain not verified, recipient refused). Fix the configuration first; a replay before that only dies again.
   - `INVALID_*_EVENT`, `ORDER_NOT_FOUND`: a code defect; do not replay, escalate to Apixel with the effect ID.
4. Fix, redeploy the worker if the configuration changed, then replay each effect: `pnpm ops:effects --replay <id> --reason "INC-n: Resend key rotated"`. The `effects.dead` alert resolves on the next clean check.
5. Expired links: replaying an old invitation or reset email sends a link that may have expired (24 h / 30 min). Prefer issuing a new one from Staff & roles.

## Provider outage

Nothing to do for orders: effects retry with backoff, then go dead and alert. When the provider is back, replay the dead ones. Do not switch `EMAIL_SEND_ENABLED` off during an outage: while it is off, emails complete as `disabled` and are lost for good, whereas dead effects can be replayed.

## Duplicates

Delivery is at least once: a provider that accepted a message just before the worker crashed may get it again. Resend receives a stable idempotency key per effect, so a retry within its window is deduplicated by the provider. A duplicate new-order email is harmless; never delete effect rows to prevent one.

## Rotating the provider key

Create the new key at the provider, put it in the secret store, redeploy the worker, run `pnpm ops:test-alert` (proves the key and sender), then revoke the old key. A leaked key: revoke it at the provider first, then the same steps.

## Restore drills and staging

Restored or staging data must never email real people: `EMAIL_SEND_ENABLED` stays off in drills (the restore drill starts no worker at all) and staging uses `EMAIL_RECIPIENT_ALLOWLIST`.
