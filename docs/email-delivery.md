# Email delivery policy (roadmap step 25)

Architecture §8 governs this policy. Email is a background effect: its failure never rolls back the business action that caused it.

## Pipeline

1. The business transaction writes an outbox event. Its required effects include `email` only once a feature wires it in, with a backfill decision (planned: steps 78 and 92).
2. `EmailConsumer` is an `external` effect handler. A per-event **planner** loads authorized data and recipients from the database, never from the event payload. It returns the template, the data and the recipients, or nothing to send.
3. A versioned **template** validates its data and renders the text and HTML, escaping every interpolated value. A subject that contains a newline is refused, because it would allow header injection.
4. One message is sent per effect. Recipients go in Bcc, so staff never see each other's addresses.
5. The provider's receipt is stored in `consumer_effects.external_receipt` when the effect completes.

## Delivery key and duplicate risk

- The delivery key is `email-` followed by the first 40 hex characters of sha256(event ID, template ID@version, normalized recipient set). It is stable across retries. It is sent as the `Message-ID` and as the `X-IH-Delivery-Key` header.
- A provider that supports idempotency keys must receive the delivery key and use it for de-duplication. Record the provider's retention window here once BI-07 chooses the provider.
- **SMTP (Mailpit, or any SMTP relay) has no idempotency key.** Delivery is therefore **at least once**. A duplicate is possible only in one window: the provider accepted the message, but the completion commit was lost (worker crash, lost lease or database outage). The runner retries the completion briefly before it gives up. Recipients and support can recognise and reconcile a duplicate by its identical `Message-ID`/delivery key. Never claim "never sends twice".
- If the effect's lease is lost while the SMTP transaction is in flight, the send cannot be recalled. The runner aborts and another runner may send again. This is the same at-least-once window, and the duplicate carries the same `Message-ID`.
- Retries are owned by the effect row: a transient failure (network, 4xx) moves the effect to `retry` with jittered backoff. A permanent failure moves it to `dead` with a code, and the effect can be replayed after a fix (audited). Permanent failures are an invalid recipient, invalid template data, a missing plan, an SMTP 5xx, or a full rejection. A partial acceptance completes the effect and is **not** retried, because a retry would duplicate the accepted copies.

## Safety controls

- `EMAIL_SEND_ENABLED` defaults to off and accepts only `"true"` or `"false"`. While it is off, the disabled adapter sends nothing and records `disabled:<key>`. Those effects are **completed**, so turning sending on later does not deliver the backlog. Any of them that still matters must be sent through a deliberate, audited replay or a fresh event.
- A real relay without implicit TLS must use STARTTLS (`requireTLS`). Only a local sink may use plain SMTP. A partial acceptance is recorded in the receipt as `;rejected=<n>`. SMTP 530/535 (authentication) counts as a configuration fault and is retried, not marked dead.
- In development and test, sending is permitted only to a local SMTP sink (`localhost` or `mailpit`). CI runs a Mailpit service container. The tests never email a real person.
- In staging, sending requires `EMAIL_RECIPIENT_ALLOWLIST` (addresses or `@domains`). Anything outside the allowlist is dropped. If no recipient remains, the message is suppressed (`suppressed:allowlist`).
- Logs carry the delivery key, template, effect ID and counts. They never carry addresses, message bodies or credentials.

## Waiting on business input

BI-07 covers the provider and its idempotency support, the sender domain (SPF/DKIM/DMARC) and the recipients of new-order, low-stock and daily-summary mail. Authenticated, idempotent bounce/complaint callbacks are provider-specific and arrive with the provider adapter.
