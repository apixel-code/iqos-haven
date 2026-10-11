# 0024 — Age-ticket signer, verifier and key ring

- Date: 2026-10-11
- Status: accepted (policy values pending BI-04)
- Step(s): 55 (routes and cookie: 56; preview: 57; first protected endpoint: 58)

## Context

Roadmap step 55: an age-ticket signer/verifier and key ring, with the private key in the storefront only, public verification keys elsewhere, and a fixed algorithm, key id, audience and expiry. Architecture §9 requires Ed25519 with a fixed algorithm allowlist, a ticket carrying `kid`, issuer, audiences, issued-at/expiry, policy version and the accepted decision, and rotation by overlapping public keys.

BI-04 (minimum age, gate copy, re-check frequency, cookie lifetime) is OPEN and blocks steps 55–57. Marina chose on 2026-10-11 to build the parts that do not depend on it, with the policy values in configuration.

## Decision

**Format.** `v1.<kid>.<payload>.<signature>`, base64url. The signature is Ed25519 (Node `crypto`, no new dependency) over `ih-age-ticket/v1\n<kid>\n<payload>`. The format has **no algorithm field**: the algorithm is fixed by the version, so there is nothing for a token to downgrade. The key id is inside the signed bytes, so a ticket cannot be relabelled to another allowlisted key.

**Claims.** `iss` (`ih-storefront`), `aud` (`storefront`, `api`), `iat`, `exp`, `pol` (policy version), `dec` (`accepted`). Exactly these six; anything else is refused.

**Verification order:** length and shape → key looked up by `kid` in the verifier's own allowlist → signature → claims. No claim is parsed before the signature verifies. Then: lifetime at most 30 days, audience, policy version equal to the one in force, `iat` not more than 60 s ahead, `exp` in the future. Failures return a reason code for logs; clients only see one generic refusal.

**Keys.** Raw 32-byte Ed25519 keys in base64url. Verifiers take `AGE_TICKET_PUBLIC_KEYS` (`kid:key`, up to 8, for rotation; a revoked key is removed). The signer takes `AGE_TICKET_KEY_ID` and `AGE_TICKET_PRIVATE_KEY`, which exist only in the storefront schema, and its key id must be in its own public list. `pnpm age:keygen` prints a new pair.

**Keeping the private key out of other services.** The API, worker and admin schemas record only whether `AGE_TICKET_PRIVATE_KEY` was present, never its value, and refuse to start with it in staging or production. The Next launcher removes it from the admin process environment. The API has no signing code path.

**API `AgeGuard`.** A fourth access policy, `@AgeVerified()`, enforced by the global `AccessGuard`. It reads only the `ih_age` cookie, verifies it for audience `api`, and answers 403 `AGE_VERIFICATION_REQUIRED` otherwise. It never reads the staff session, the User-Agent, headers or query parameters. Two different `ih_age` values in one request count as none. With no key configured every store route is refused. The startup check requires `@Serialize` on these routes and forbids class-level use.

**Policy values (BI-04), in configuration:**

| Setting               | Default                    | Rule                                                                              |
| --------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `AGE_POLICY_VERSION`  | `unapproved`               | Refused when `APP_ENV=production`. Changing it invalidates every existing ticket. |
| `AGE_TICKET_TTL_DAYS` | 30 (architecture proposal) | 1–30; the verifier caps at 30 days regardless.                                    |

## Waiting for BI-04

- The approved policy version string and lifetime (set the two variables; no code change).
- Minimum age and gate copy (step 56 UI).
- Re-check frequency, if it differs from the cookie lifetime.

## Alternatives considered

- **JWT/JWS with a library (`jose`).** Rejected for now: it adds a dependency and an `alg` header that must then be pinned. The purpose-specific format has less to get wrong. Revisit if another party must verify tickets.
- **HMAC.** Rejected by architecture: every verifier could then mint tickets.
- **Server-side session table for age decisions.** Rejected: guest shoppers have no account and the decision carries no personal data; a signed, expiring ticket needs no store.

## Consequences

- Rotation follows `docs/runbooks/age-ticket-keys.md`. The old public key stays until its last ticket expires (up to 30 days) plus skew.
- A ticket cannot be revoked individually; revoking a key or changing the policy version sends the affected shoppers through the gate again.
- A shared local `.env` gives every local process the private key. That is a development convenience only; deployed services get separate secret grants.
- Step 56 imports the signer through `@ih/platform/age-ticket`, which has no storage or image dependencies.
- **Step 58 must send `Cache-Control: private, no-store` (and `Vary: Cookie`) on every successful store response.** Only error responses carry `no-store` today, because no store route exists.
- Staging and production refuse to start without at least one public key (API, storefront) and, on the storefront, without a signing key that matches its listed public key.
- Two different `ih_age` cookies count as none. Someone able to set cookies for the shop's domain from a sibling subdomain could therefore send a shopper back to the gate; this is a nuisance, not a bypass.
- No store endpoint exists yet; the guard is exercised by a probe route in tests.
