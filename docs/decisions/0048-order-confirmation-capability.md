# 0048 — Cookie-only order confirmation and encrypted replay

- Date: 2026-10-13
- Status: accepted
- Step(s): 79

## Context

An acknowledged or lost-response checkout needs private confirmation access without exposing credentials in URLs or replay JSON. The sanitized success remains replayable for 24 hours; confirmation access lasts only 30 minutes. Expiry must never place another order.

## Decision

- Generate a random 256-bit capability before the order transaction. Persist its SHA-256 verifier and DB-clock 30-minute expiry on the order; persist only AES-256-GCM encrypted replay material in separate idempotency columns, atomically with the order, response, ledger, history, audit and events. The response JSON stays order number/total/time only.
- Bind ciphertext with authenticated associated data to `store.checkout` and the scoped key hash. Use API-only `ORDER_CONFIRMATION_KEYS=confirmation:kid:<canonical 32-byte base64url secret>`; the first encrypts, retained keys decrypt. Require managed keys for enabled staging/production checkout. Dev/test may use an ephemeral process key; its retirement loses cookie restoration, never the placed order.
- After commit, restore only material matching the committed order/key linkage, exact database expiry and verifier. Copy expiry within SQL to preserve microseconds; normalize adapter BYTEA values to Buffers before decrypting. Restore failures from missing/retired keys return the same success without a cookie, never mint replacement access or run order creation again.
- Set `__Host-ih_order` from the storefront gateway response with Secure, HttpOnly, SameSite=Lax, Path=/, no Domain and remaining Max-Age. Replay does not extend expiry. A new acknowledgement replaces that browser cookie; older valid capabilities remain independently scoped until expiry.
- `GET /v1/store/order-confirmation` authenticates only this capability cookie, independently of admin/age sessions. No query fields, URL tokens or order-number/phone lookup. Missing, malformed, duplicate, unknown and expired capabilities return the same 401. Apply a bounded per-address read limit with local/process outage fallback. Gateway surface separation remains unchanged.
- Return only confirmation snapshots: order number/time/status, totals, delivery ETA/address and item names/options/quantities/prices. Exclude customer name/phone, notes/Makani, internal IDs, capabilities and encrypted material. Responses are private no-store, vary Cookie and no-referrer. The private order snapshot is not a public catalogue read.
- Database guards prohibit changing completed replay material or expiry, including attaching new material after a null/cleared state. Only already-expired material can be cleared. A bounded worker job `confirmation.cleanup` runs every minute; actual access expires immediately at the database clock even if cleanup is delayed. Sanitized idempotency answers retain their separate lifetime and permanent order key remains authoritative after cleanup.

## Alternatives considered

- Raw capability in the replay response or URL — exposes access through browser storage/history/logs.
- New capability on every replay — extends access and complicates response-loss races.
- Plaintext replay material or reused quote keys — breaks secret-purpose separation.

## Consequences

Apply the additive migration before deploying the new API/worker. Provision keys only to the API, keep prior decrypt keys through the last 30-minute issuance window plus rollout margin, and monitor cleanup. Removing a key does not revoke already-issued hash-authorized cookies. No real keys, emails or business identities are provisioned in this step. Checkout/confirmation UI and the full worker/browser journey remain steps 80–82; checkout stays off by default and no M7 gate is claimed.
