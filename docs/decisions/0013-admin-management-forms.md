# 0013 — Versioned admin management forms and session recovery

- Date: 2026-10-10
- Status: accepted
- Step(s): 40

## Context

Steps 35–39 supply authoritative staff, settings and delivery APIs. Admin sections must use those contracts and current permissions without copying prototype data or guessing business values.

## Decision

- Mount settings, staff and delivery management only with the respective current permission. Delivery has an independent `delivery.manage` navigation entry. API authorization remains authoritative.
- Use same-origin cookie requests with no-store, strict response/body contracts, bounded request deadlines and generic errors. Keep snapshots and drafts in memory. Abort and generation-fence superseded reads/mutations; pause writes during session verification and hide private content after denial or failed verification. Background verification retains drafts; route changes discard old-page snapshots.
- Submit complete typed configuration groups and current expected versions; absent values remain visibly unconfigured. Use returned versions, explicit reload after conflicts/uncertain saves and null clears preserving history. Parse decimal AED strings into integer fils without floating multiplication. Free delivery remains disabled.
- Use bounded staff/area cursor pages, stable area codes, inactive-by-default area creation, fixed Owner/Staff roles and confirmation before role/deactivation/clear commands. Reload authoritative staff state after bodyless deactivation rather than inventing a version. Self-email/role/deactivation commands return to sign-in. Backend last-Owner guards remain unchanged.
- Issue invitations through the existing API; show queue receipt/expiry and allow last-issued revocation. Queueing does not imply email delivery. No passwords are set in staff forms, and no new invitation listing API is invented.
- Use labeled native controls, disabled pending/conflict states, live notices and shared light/dark tokens. Bound mobile grid tracks and sidebar minimum width so horizontal navigation scroll stays inside the sidebar.

## Alternatives considered

- Copy prototype settings/staff records — introduces invented business data and bypasses API authority.
- Optimistically increment versions or retry stale saves — loses no-op semantics and risks overwriting concurrent work.
- Unmount all forms on background session checks — discards unsaved drafts whenever focus changes.

## Consequences

No API, database migration, dependency or environment change is needed. Automated verification and desktop actual-origin management/RBAC/recovery checks pass; 375px responsive layouts and reset/invite fragment scrubbing are inspected. New-password reset/invitation browser submission and real mobile touch/keyboard acceptance remain explicit manual QA follow-ups. Real business values still require approval; M3 is not closed by this implementation.
