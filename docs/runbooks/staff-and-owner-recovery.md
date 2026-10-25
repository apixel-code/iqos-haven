# Staff and Owner access recovery

Start an incident record: UTC time, who reported it, which account (ID, not the email in shared notes), and what was seen. Never write passwords or links into the record.

## A staff member forgot their password

The staff member uses "Forgot password" on the admin sign-in page, or an Owner sends one from Staff & roles (row menu → Send password reset). The link lasts 30 minutes; a new one revokes the old.

## A staff account is compromised (or the person left)

1. An Owner opens Staff & roles → the account's menu → **Deactivate**. This, in one audited transaction:
   - signs the account out of every session (live admin streams close),
   - voids its unused reset links,
   - revokes the invitations it sent that are still pending.
2. Check the audit log for `staff.invited` / `staff.invitation_accepted` entries by that account: deactivate any account it brought in that you do not trust.
3. Review what it did: the audit log entries for that account since the suspected time (orders, stock, coupons, settings, report downloads).
4. Reverse business changes only with normal commands (stock adjustment with a reason, order edit or cancel with a reason, coupon edit). Never edit tables directly.
5. To let the person back later: **Reactivate**, then send a password reset. Reactivation also signs out any session and voids old links.

## An Owner forgot their password

Use "Forgot password" (needs working email; see the email runbook), or another Owner sends a reset from Staff & roles.

## An Owner account is compromised

If another Owner can sign in: they deactivate it (the last-Owner guard refuses only if it is the last active Owner), then follow the staff steps above.

If it is the only Owner, or every Owner is locked out: use the break-glass command below. It resets that Owner's password and signs the attacker out everywhere.

## Break-glass: no Owner can sign in

When nobody can use the admin (the only Owner lost the password and email is not working, every Owner was deactivated, or the only Owner is compromised):

1. Get the business's authorization through the agreed channel (BI-11) and an incident ID.
2. On the server, with the runtime database credentials:

   ```
   pnpm ops:owner-recovery --email <owner address> --reason "INC-12: sole Owner locked out, approved by <who>"
   ```

   The new password is typed twice and not shown (or piped with `--password-stdin` from the secret store). Same rules as every password: 12+ characters, not containing the email, name, brand or common words.

3. What it does, in one transaction under the Owner lock: only for an account that **already has the Owner role** (it never creates an account or changes a role), it sets the new password, reactivates the account, bumps its version, revokes all its sessions, reset links and pending invitations, and writes the audit entry `staff.owner_recovered` (with the reason) and its events.
4. It refuses if another Owner is active, because that Owner can fix it in the admin. If that other Owner is the compromised one, rerun with `--despite-active-owner`, then sign in and deactivate the untrusted Owner.
5. Sign in with the new password. Then: review Staff & roles (deactivate anything unexpected), read the audit log, and rotate keys the attacker may have seen (secrets runbook). Tell the Owner to change the password again from their own device if it was set by an operator.

Exit codes: 0 restored; 2 bad input or password, nothing changed; 3 refused (not an Owner, or another Owner active), nothing changed; 1 database error, nothing changed.

## Keys behind access

A leaked `PASSWORD_RESET_KEYS` or `STAFF_INVITATION_KEYS` entry: follow its section in the secrets runbook (remove the key everywhere and void unused links for its key ID). A leaked session cookie: deactivate and reactivate the account, or reset its password; both revoke every session.
