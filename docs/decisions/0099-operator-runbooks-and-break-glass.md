# 0099 — Operator runbooks, dead-effect replay command and break-glass Owner recovery

- Date: 2026-10-25
- Status: accepted
- Step(s): roadmap step 127 (architecture §8, §11, §15)

## Context

Step 127 asks for runbooks an operator can act on, with exercised procedures, and recoverable compromised keys and staff access. Two procedures existed only as library functions or prose:

- Dead effects: `listDeadEffects` / `replayDeadEffect` (step 24) had no caller, so an operator could not see or replay them without SQL.
- Owner recovery: the runbook said a separately authorized recovery tool had to be provisioned before release, for the case where no Owner can sign in or receive a reset email (sole Owner locked out, every Owner deactivated, or the only Owner compromised).

## Decision

- **`pnpm ops:effects`** (worker) lists dead effects with ID, consumer, event type, attempts, replays and error code — never payloads. `--replay <id> --reason "<incident>"` calls `replayDeadEffect`: dead → pending with a fresh budget, audited `effect.replayed` with the reason, then the reconciler enqueues it. The reason (8–500 characters) is required.
- **`pnpm ops:owner-recovery --email <owner> --reason "<incident>"`** (API CLI, `recoverOwnerAccess` in `@ih/db`): in one transaction under the common Owner lock, for an account that **already holds the Owner role** only:
  - sets a new argon2id hash (password read like bootstrap: hidden prompt or `--password-stdin`, never an argument or env),
  - reactivates the account and bumps its version,
  - revokes every session (`owner_recovered`), unused reset link and pending invitation of it,
  - writes the audit entry `staff.owner_recovered` with the reason and the `staff.password_reset` (+ `staff.reactivated`) events.
  - It never creates an account or changes a role or grant. It refuses while another Owner is active (that Owner can act in the admin) unless `--despite-active-owner` declares that Owner untrusted.
  - Authorization is server shell access plus the runtime database credentials, plus the business's approval recorded in the incident (BI-11). There is no HTTP route.
- **Who ran it**: the audit actor is `system` (no staff session exists in these cases); both CLIs append `[server user <os user>]` to the audited reason, and the reason must name the incident (8–500 characters, also enforced in `recoverOwnerAccess`).
- **Runbooks**: an index (`docs/runbooks/README.md`) by situation and command; new `email-delivery.md`, `uploads-and-media.md`, `staff-and-owner-recovery.md`; `incident-and-queue-recovery.md` rewritten around concrete commands; rollback decisions added to `deploy-and-rollback.md`.

## Consequences

- Both commands were exercised on an isolated database (see docs/verification.md, step 127). Staging/VPS service names and the release rehearsal follow in steps 122 and 128.
- Anyone with production shell and database access can already change any row; the break-glass command does not widen that, it makes the safe path the easy one and leaves an audit trail.
