# 0004 — Email provider: Resend, launch scope new-order email

- Date: 2026-10-09
- Status: accepted
- Step(s): 25, 78, 92, 107

## Context

BI-07 asked for the email provider. Architecture §8 asks us to use the provider's idempotency key wherever the provider offers one. Apixel (Marina) decided on Resend. The sending domain is not verified yet. At launch only new-order email is needed. Low-stock and daily-summary email will come later.

## Decision

- Add a Resend adapter next to the SMTP adapter. `EMAIL_PROVIDER=resend` selects it and `RESEND_API_KEY` authenticates it. SMTP/Mailpit stays the local and test path.
- Send through Resend's batch endpoint: one email per recipient, no Bcc, at most 100 per request. The request's `Idempotency-Key` is our delivery key, suffixed per chunk of 100. Resend keeps the key for 24 hours and answers a same-payload retry without sending again.
- Error classes:
  - Validation errors (400, 422) are permanent, and so are wrong endpoints (404, 405).
  - 409 `invalid_idempotent_request` (same key, different payload) is permanent, with code `IDEMPOTENCY_CONFLICT`.
  - Authentication, permission, quota and unverified-domain errors (401, 403) are configuration faults. They are retried, and once the attempt budget is used the effect goes dead and can be replayed.
  - 409 concurrent/locked, 429 and 5xx are retried.
- Outside production, sending through Resend requires `EMAIL_RECIPIENT_ALLOWLIST`.
- Launch wiring: step 78 adds the `order.created` → `email` consumer with a new-order template. Low-stock (92) and the daily summary (107) keep the in-app bell only until they are re-scoped.

## Alternatives considered

- SMTP relay through Resend's SMTP endpoint. It is simpler, but it has no idempotency key, so delivery stays at-least-once with a duplicate window.
- One email with all recipients in Bcc. It would use one key, but per-recipient emails are clearer for deliverability and privacy, and batch keeps them under one key.

## Consequences

- Duplicate risk after a lost completion commit drops to zero within 24 hours. After that window it is the same as SMTP (documented in docs/email-delivery.md).
- Planners must render from immutable snapshots, for example order snapshots. If content changed between retries the request would hit `IDEMPOTENCY_CONFLICT`.
- Still to decide before go-live: verify the sending domain (SPF, DKIM, DMARC), choose the sender address, name the new-order recipients, and add authenticated, idempotent bounce/complaint webhooks.
