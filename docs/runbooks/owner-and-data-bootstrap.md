# Owner, real catalogue and initial stock bootstrap

The first-Owner command exists (step 28). The catalogue import is pending. The repository holds no default Owner password, no Owner identity and no demo seed.

## First Owner (one time)

1. Get the real Owner's email and full name from the client (BI-11) through a secure channel. Never commit them.
2. On the target environment, with the runtime database credentials, run `pnpm bootstrap:owner --email <address> --name "<full name>"`. The Owner types the password twice, and it is not shown on screen. For automation, pipe it to `--password-stdin` from a secret manager. Never put it in an argument or an environment variable.
3. Password rules: at least 12 characters, at most 128, and it must not contain the email, the name, the brand or common words. It is stored only as an argon2id hash.
4. The command refuses if any Owner exists, active or deactivated. It locks the Owner-role row, so concurrent runs cannot each create one. Creation is audited as `staff.owner_bootstrapped`, with personal fields redacted.
5. Before go-live, run `pnpm identity:benchmark` on the production runtime and set `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` to about 250–750 ms per hash within the memory budget. The defaults (64 MiB, t=3, p=1) measured about 64 ms on a 2026 Apple-silicon laptop. Existing hashes keep verifying, and `needsRehash` upgrades them at the next login.
6. If the Owner becomes unavailable, recovery is a separate, audited operational process. Re-running bootstrap is never the recovery path.

Collect BI-11 approved Owner/staff identities, secure first-Owner delivery/recovery channel, BI-01 brand/contact and BI-10 real catalogue/assets. Establish normalized explicit permission seeds; all future Owner membership changes lock the same Owner-role row before staff rows. Create credentials/tokens through the reviewed one-time command; no browser role chooser or prototype loginAs in production.

Import verified brands/categories/products, exact variant SKU/option signatures/prices/tax-treatment versions and approved images. A no-option product has one default variant. Opening balances start at zero and become INITIAL_STOCK movements, not direct stock mutations. Validate constraints and ledger totals; do not overwrite history on a repeated import. Domain commands record actor/command/version/audit/effects.

Set approved Dubai areas/flat fee/ETA, tax basis/examples, age/preview/privacy policies, recipients and WhatsApp copy. Free threshold remains off. Resolve BI-01–BI-11 and record decisions; placeholder brand/fee/contacts/prototype codes are not approval. No automated real-customer messages during bootstrap/drills.

## Unavailable Owner recovery

1. Record the incident ID, operator, affected account ID and authorization from the business through the approved secure recovery channel (BI-11); keep passwords and token URLs out of incident notes. Preserve current audit/history and use the intended environment.
2. If the active Owner can receive verified mail, use the configured password-reset flow. Successful reset is audited and revokes sessions/sibling reset links; log in again. Delivery prerequisites from steps 33–34 apply. Do not change the password through SQL or rerun first-Owner bootstrap.
3. If another active Owner is available, that Owner may reactivate the saved account or change its fixed role through the step-36 versioned commands. Reload the current version, use the admin origin and log in again after the change. These commands recheck authority, serialize the last-Owner invariant and atomically audit/revoke old sessions and capabilities. Reissue needed invitations explicitly; revoked links stay revoked.
4. If no authorized Owner can authenticate or receive reset mail, normal API recovery is blocked. Before release, provision and rehearse a separately authorized operational recovery procedure against the chosen infrastructure. Any recovery tool must lock the seeded Owner role before sorted affected-user rows, preserve an active Owner, require an incident reason, increment versions, revoke sessions/reset/issued invitations and write audit/outbox atomically. Reset credentials only through the reviewed hasher and secret input channel; never add a default password or change immutable role grants. A public bypass/recovery CLI is not provided by this step.
5. Verify the restored account's seeded permissions and fresh session, old-session/link rejection and recovery audit/event IDs. Record the outcome and rotate compromised credentials through the secrets runbook. Production recovery evidence remains a release prerequisite; no recovery was performed on real identities here.

## Approved settings configuration (step 38)

Deploy additive migration `20261010000200_settings` before the settings API. Initially no rows exist: an authorized Owner's `GET /v1/admin/settings` returns four null/version-0 groups. Collect approved BI-01 brand/domain/legal/contact copy, BI-09 WhatsApp number/wording and remaining BI-07 notification recipients first. Do not copy prototype/demo defaults.

Use the actual admin origin, `settings.manage` session and JSON `PATCH /v1/admin/settings` with `{key, version, value}`. Version 0 creates an absent key; use the returned version for subsequent changes, and reload on 409. Send the complete typed value for the selected key; null explicitly clears it without deleting history. Optional contacts/social/template values are nullable. Email recipients are capped at ten and unique case-insensitively; enabled new-order email requires recipients. Low-stock/daily email, provider credentials and arbitrary setting keys are rejected. Preserve IDs/version/request audit evidence without copying private configuration into incident notes.

Saving values does not activate email/WhatsApp automation. Provider credentials/origins, default-off/staging allowlists and delivery provisioning remain separate. Future notification/link consumers must validate approved settings and escape template values. Settings UI is step 40; approved real bootstrap remains step 124. No real configuration/migration was performed by step 38 tests.

## Approved delivery configuration (step 39)

Deploy migration `20261010000300_delivery_configuration`; collect BI-03 approved Dubai area names/codes, coverage/exclusions, one flat fee and ETA first. No prototype seeds are installed. Initially `GET /v1/admin/delivery-areas` is empty and `/configuration` returns null/version 0. Use an actual admin-origin Owner session with `delivery.manage`; all bodies are strict JSON.

Create each approved area with `POST /v1/admin/delivery-areas` `{code,name,active}` (201, version 1). Codes are immutable lower-case identifiers; names are unique case-insensitively. List via bounded `limit`/`after` cursor. Change name/active via `PATCH /:id` `{version,name,active}`; deactivate rather than delete. Configure `/configuration` with `PATCH` `{version,value:{flatFeeFils,etaText,freeThresholdFils:null}}`; version 0 is only for an absent row, and `value:null` clears while retaining version history. Reload on 409 rather than silently overwriting another operator. One fee applies to every active Dubai area; free delivery stays disabled.

This does not validate a typed address's boundary, enable checkout or create orders. Admin forms are step 40 and quote/order acceptance is later commerce work. No real coverage/fee/ETA or live migration was applied by the step-39 tests.
