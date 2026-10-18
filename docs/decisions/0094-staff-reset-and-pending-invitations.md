# 0094 — Owner-sent staff password reset and pending invitations

- Date: 2026-10-18
- Status: accepted
- Step(s): parity gap G-A11 (follows ADRs 0007 and 0010)

## Context

The prototype's staff menu has "Send password reset". Our admin could not send one, and the only way to revoke an invitation was the one just issued in the same visit; the API already supported revoke by id. Marina chose G-A11 for launch (2026-10-17).

## Decision

- **Owner-sent reset:** `POST /v1/admin/staff/:id/password-reset` (`staff.manage`, staff-management rate limit, 204).
  - It issues the same token as a self-service reset: 30 minutes, hash-only, bound to the user's version. The same `staff.password_reset_requested` event and email follow.
  - The Owner is the audited actor. The repository rechecks that the actor still holds `staff.manage` and locks the target.
  - Refusals:
    - 404 for an unknown account, or when the email changed between read and lock (retry);
    - 409 `STAFF_INACTIVE` for a deactivated one.
  - Unlike self-service, the answer is not uniform: only the Owner can call it, and they already see every account.
  - The current password keeps working until the link is used.
- **Pending invitations:** `GET /v1/admin/staff/invitations` (`staff.manage`) returns at most 100 invitations, newest first, neither accepted nor revoked.
  - Each item carries email, name, role, the inviter's name, created and expiry times, and an `expired` flag.
  - Expired ones stay listed, so they can be revoked or re-sent.
  - No token or hash leaves the server.
- **Admin (Staff & roles):**
  - a "Pending invitations" card with "Revoke invitation" (after a confirmation), refreshed after each invite;
  - "Send password reset" on every active account, after a confirmation, then a status line saying the link was queued (delivery not confirmed).
  - The one-off revoke button under the invite form is replaced by the list.

## Consequences

- An Owner can help a locked-out colleague without sharing passwords, and clean up stray invitations.
- The reset email keeps its wording ("If you did not request this, ignore this email."), which is slightly off for an Owner-sent link. Changing the template is left to the email copy review (BI-01).
