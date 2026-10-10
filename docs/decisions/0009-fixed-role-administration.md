# 0009 — Shared identity transactions and fixed-role administration

- Date: 2026-10-10
- Status: accepted
- Step(s): 36

## Context

Deactivation and role demotion must preserve the final active Owner under concurrent requests. Step 35 already protects deactivation, but fixed-role changes/reactivation need the same transactional authority, versions and session/capability cleanup. Launch roles are Owner and Staff; custom role editing stays deferred.

## Decision

- Extract shared staff authority/errors, Owner-role → sorted actor/target row locking, last-active-Owner preservation and security capability invalidation into `packages/db/src/identity-transaction.ts`. Profile edits, deactivation, role changes and reactivation use this shared transaction support. Bootstrap and invitations retain the same seeded `lockOwnerRole` guard. No new migration is needed.
- Add `POST /v1/admin/staff/:id/role` with strict `{version, role: owner|staff}` and `POST /v1/admin/staff/:id/reactivate` with strict `{version}`. Both require fresh `staff.manage`, current aggregate version, no-store, strict public profile serialization and the existing fail-closed staff write budget. Success is 200 with the current sanitized profile; stale version/last active Owner is 409. Roles/permissions cannot be edited or supplied as arbitrary IDs/keys/grants.
- Role changes preserve active state and password; inactive accounts stay inactive. Demotion and deactivation check the current active-Owner count after common locking. Concurrent self-demotions or mixed demotion/deactivation leave one active Owner. Reactivation preserves saved role/password and increments version only when inactive. Same-role/currently active commands are no-ops at the current version with no new audit/effect.
- Any actual role change or reactivation revokes all sessions, unused reset verifiers and pending invitations issued by the account in the same transaction as audit/outbox. Reactivation never revives old sessions or links. Self role changes clear the cookie; callers log in again for current DB-derived permissions. The existing user-version/hash session fence rejects pre-change logins even when the password is unchanged.
- `staff.role_changed` and `staff.reactivated` carry only user ID with empty consumer sets. No historical completion/backfill changes. No new secrets/configuration; steps 33–34 reset/invite delivery prerequisites remain.
- Document unavailable-Owner recovery separately in the bootstrap runbook; bootstrap cannot bypass an existing Owner. Normal recovery uses a remaining Owner or the password-reset flow, with audited commands and no default password. Recovery without an available authorized Owner requires a controlled operational process before release, not a public bypass endpoint.

## Alternatives considered

- Separate last-Owner checks per endpoint — invites drift and races between demotion and deactivation.
- Reactivation by invitation — would overwrite identity or revive revoked capabilities.
- Permission/custom-role editor — deferred launch scope; immutable seeded grants remain authoritative.

## Consequences

Backend fixed-role administration is complete; frontend auth/reset/invite work continues in step 37. Account history is preserved. Operators must validate production recovery and actual identities/infrastructure under BI-11/BI-06 and release drills. This does not close M3.
