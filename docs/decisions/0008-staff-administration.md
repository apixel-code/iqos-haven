# 0008 — Versioned staff administration and identity session fencing

- Date: 2026-10-10
- Status: accepted
- Step(s): 35 (shared role administration continues in 36)

## Context

Staff administration is Owner-only under the explicit `staff.manage` grant. Accounts are deactivated, never deleted. Changes must not leave old sessions/capabilities alive or permit concurrent removal of the last active Owner. Step 36 owns fixed-role changes/reactivation; step 35 cannot expose unsafe deactivation while waiting for it.

## Decision

- Add `GET /v1/admin/staff` (keyset ID pagination, default 25/max 100), `PATCH /v1/admin/staff/:id` (name/email and required version), and `POST /v1/admin/staff/:id/deactivate` (required version). Responses use strict serializers selecting public staff profile fields only; never hashes, MFA material or tokens. All require `staff.manage` and no-store. Name/email normalized server-side. No role, active flag, password or permission fields may be edited by these contracts.
- Mutations first lock the seeded Owner-role guard, then actor/target staff rows in sorted ID order. Recheck current actor active/permission state after locking. Compare the current aggregate version; stale writes return generic 409. A genuine no-op preserves version/audit/effects; deactivation is idempotent at the current inactive version.
- Deactivation refuses the last active Owner under the common lock, even for concurrent self-deactivations. It updates active/version/timestamp, revokes all sessions, consumes unused reset verifiers and permanently revokes that user's pending issued invitations, with audit/outbox in one transaction. Email changes do the same capability/session cleanup (`admin_revoked`), update version, and never modify role or password. Profile-only name changes preserve existing sessions; they still increment identity version and invalidate old version-bound reset flows.
- Session creation checks both the verified password hash and the candidate's identity version under the user lock. Without this fence, a login begun at an old email could create a new session after email-change revocation while the password hash stayed unchanged. Any intervening profile/security mutation refuses that pending login; retrying with the current identity works. Existing sessions still authenticate from current DB permissions/active state.
- Self email change/deactivation clears the admin cookie. No automatic re-login, hard deletion or reactivation. Write budgets are separate from invitations/reset: IP/actor 30/hour, fail closed (503) when the authoritative limiter is down, 429 + Retry-After on denial. Staging validation remains M11.
- New `staff.updated`/`staff.deactivated` events carry only user ID and have no required effects yet. Invitation revocations use their existing new-type audit/events. Historical consumer sets remain unchanged. Existing schema suffices; no migration or new secret configuration is required by step 35.

## Alternatives considered

- Delay last-Owner enforcement until 36 — would expose an unsafe endpoint now.
- Revoke only on deactivation — old email sessions and in-flight logins would survive a security edit.
- Accept role/active fields in the edit endpoint — mixes the fixed-role/last-Owner/reactivation work planned for 36 into this contract.

## Consequences

Step 36 should consolidate common role/identity guards and add fixed-role administration with the same session/capability invalidation and last-Owner rules. Admin UI is step 37. Existing users remain auditable; stale editors must reload the current version. Revoked invitations do not regain validity on later reactivation. Reset/invite deployment prerequisites from steps 33–34 still apply; this work creates no real users and changes no `.env` secrets. No M3 gate closes here.
