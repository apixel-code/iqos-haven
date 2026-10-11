# 0006 — Hashed reset verifiers with purpose-keyed durable delivery

- Date: 2026-10-09
- Status: accepted
- Step: 33

Architecture §11 requires hashed, single-use 30-minute reset tokens; §8 requires email through durable effects with IDs-only payloads. A worker cannot send a random plaintext token from its hash.

Each issue uses a random UUID selector plus a 256-bit HMAC-SHA256 secret, derived under a dedicated reset key with the `ih:password-reset:v1` purpose prefix. PostgreSQL stores only SHA-256 of the complete token, the selector/key ID, issuing user version, and a purpose-keyed recipient fingerprint. The event contains only the selector. The worker reproduces the identical token from the key held outside the database. It checks verifier, recipient, active state, user version, use and expiry before planning an email. No historical event consumer sets change; the two reset event types are new and need no backfill.

`PASSWORD_RESET_KEYS` is a ring of `reset:keyId:base64urlSecret` entries (at least 32 random bytes); first entry issues links, any retained key can deliver them. API and worker share this separate-purpose ring, independent of internal service keys. Empty keys make both reset endpoints return 503. `PASSWORD_RESET_ORIGIN` is a configured bare admin origin (HTTPS in deployed environments), never a request Host/Origin used to build links. Retain old keys until pending links expire and rollout completes. Compromise: remove the key everywhere and invalidate its unused rows; incident recovery is audited. API consumption verifies the stored hash rather than re-deriving the token, so key removal alone does not revoke an already delivered link.

Email uses `/reset#token=...`: fragments never enter HTTP request URLs or referrers. Step 37 will read/clear the fragment and submit the token in a JSON body, keeping it out of persistent browser storage. This step adds the backend and email only; there is no working reset page yet.

Issue, audit and outbox commit together. Consume locks the user before atomically consuming the token, replacing the password, incrementing user version, revoking all sessions and invalidating sibling links, plus audit/outbox. Session creation now takes the same user lock before checking the verified hash, preventing an old-password login from committing behind a reset. Hashing and email happen outside transactions. Invalid/expired/reused/inactive tokens and rejected passwords receive the same generic 400; valid forgot requests return `{accepted:true}` regardless of account existence, without auto-login.

Reset-request budgets: IP 20/15 min and normalized identity 3/30 min. Consume: IP 20/15 min. Both use the step 32 authoritative limiter and fail closed (503); denials are generic 429 with Retry-After. New requests do not invalidate previous valid links, so an attacker cannot continually invalidate a legitimate email. A successful consume invalidates all of them. Limits need staging validation (M11).

Tradeoff: compromise of the reset key together with reset-table selectors reveals live reset secrets. Keep key access separate from database reads. A database dump alone cannot reconstruct links. An email already in flight can arrive after revocation/expiry; its link is still refused by PostgreSQL. SMTP remains at-least-once; retries use the same link and delivery key. Missing/wrong delivery keys retry or suppress safely; email go-live remains BI-07. Expired rows and effects are retained until retention policy is approved (BI-08).
