# Owner, catalogue and settings bootstrap

The first Owner is created with a one-time command (step 28). Everything else is entered through the admin by the Owner (BI-10, BI-11, Marina 2026-10-12): there is no catalogue import command and no demo seed. The repository holds no default Owner password, no Owner identity and no demo data. Before the store opens, `pnpm launch:check` must report no blocking item (step 124, ADR 0095).

## Launch sequence

1. **Migrations.** Deploy with the migration role: `pnpm db:migrate`.
2. **First Owner.** Create an Apixel account with `pnpm bootstrap:owner` (see below; Marina 2026-10-17).
3. **Hand over.**
   - The Apixel Owner signs in and invites the client's Owner from Staff & roles. Pending invitations shows the link's expiry.
   - Once the client's Owner has accepted and signed in, they deactivate the Apixel account. The last-Owner guard keeps at least one active Owner at every moment.
4. **Settings** (Owner, admin):
   - Store: name "Iqos Haven", domain `iqoshaven.com` (BI-01).
   - Contact.
   - WhatsApp number (BI-09).
   - Notifications: new-order recipients.
   - SEO: indexing `public_pages` (BI-05).
   - Delivery: one flat fee and the promise text, plus active areas across the seven emirates (BI-03). The free-delivery threshold stays off.
5. **Catalogue** (Owner or Staff, admin):
   - Brands with logos, then categories with images.
   - Products with their options, SKUs and prices. The price entered is final; there is no tax calculation (BI-02).
   - Images, then opening stock in Inventory: an `INITIAL_STOCK` ledger movement, never a direct stock edit.
   - Publish each product.
6. **Check.** Run `DATABASE_URL=<production> pnpm launch:check`. It only reads.
   - It exits 1 while anything blocks, and 0 when ready. Warnings need a conscious decision.
   - Run it with the migration role so it can compare the applied migrations with the ones this build ships. With the runtime role that line is a warning.
   - Its output holds counts and setting names only, no personal data.
7. **Open.** Once the sender domain is verified (BI-07), set `CHECKOUT_SUBMISSION_ENABLED=true` and redeploy. Then run `pnpm launch:check` once more.

### What `launch:check` blocks on

- Migrations not applied, or unfinished.
- No active Owner.
- Any staff account on a reserved test domain (`.test`, `.invalid`, `.example`, `localhost`, `example.com`).
- Store name or domain missing, or the domain reserved.
- No contact email or phone.
- No WhatsApp number.
- Delivery fee or promise missing, or no active area.
- Nothing published.
- A published product with no active option or no image.
- Stock that differs from the stock ledger.
- Prototype demo coupon codes (`HAVEN10`, `SAVE20`, `VEKTOR15`, `BIGBOX15`).
- Product, brand or category slugs starting with `gatecheck`, `qa`, `test`, `synthetic` or `fixture`.

It warns on:

- sold-out published products (they stay listed);
- new-order email alerts off;
- SEO indexing still closed;
- dead background effects (see the incident and queue recovery runbook).

## First Owner (one time)

1. Get the real Owner's email and full name from the client (BI-11) through a secure channel. Never commit them.
2. On the target environment, with the runtime database credentials, run `pnpm bootstrap:owner --email <address> --name "<full name>"`. The Owner types the password twice, and it is not shown on screen. For automation, pipe it to `--password-stdin` from a secret manager. Never put it in an argument or an environment variable.
3. Password rules: at least 12 characters, at most 128, and it must not contain the email, the name, the brand or common words. It is stored only as an argon2id hash.
4. The command refuses if any Owner exists, active or deactivated. It locks the Owner-role row, so concurrent runs cannot each create one. Creation is audited as `staff.owner_bootstrapped`, with personal fields redacted.
5. Before go-live, run `pnpm identity:benchmark` on the production runtime and set `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` to about 250–750 ms per hash within the memory budget. The defaults (64 MiB, t=3, p=1) measured about 64 ms on a 2026 Apple-silicon laptop. Existing hashes keep verifying, and `needsRehash` upgrades them at the next login.
6. If the Owner becomes unavailable, recovery is a separate, audited operational process. Re-running bootstrap is never the recovery path.

## Unavailable Owner recovery

1. Record the incident ID, operator, affected account ID and authorization from the business through the approved secure recovery channel (BI-11); keep passwords and token URLs out of incident notes. Preserve current audit/history and use the intended environment.
2. If the active Owner can receive verified mail, use the configured password-reset flow. Successful reset is audited and revokes sessions/sibling reset links; log in again. Delivery prerequisites from steps 33–34 apply. Do not change the password through SQL or rerun first-Owner bootstrap.
3. If another active Owner is available, that Owner may reactivate the saved account or change its fixed role through the step-36 versioned commands. Reload the current version, use the admin origin and log in again after the change. These commands recheck authority, serialize the last-Owner invariant and atomically audit/revoke old sessions and capabilities. Reissue needed invitations explicitly; revoked links stay revoked.
4. If no authorized Owner can authenticate or receive reset mail, normal API recovery is blocked. Before release, provision and rehearse a separately authorized operational recovery procedure against the chosen infrastructure. Any recovery tool must lock the seeded Owner role before sorted affected-user rows, preserve an active Owner, require an incident reason, increment versions, revoke sessions/reset/issued invitations and write audit/outbox atomically. Reset credentials only through the reviewed hasher and secret input channel; never add a default password or change immutable role grants. A public bypass/recovery CLI is not provided by this step.
5. Verify the restored account's seeded permissions and fresh session, old-session/link rejection and recovery audit/event IDs. Record the outcome and rotate compromised credentials through the secrets runbook. Production recovery evidence remains a release prerequisite; no recovery was performed on real identities here.

## Approved settings configuration (step 38)

Deploy additive migration `20261010000200_settings` before the settings API. Initially no rows exist: an authorized Owner's `GET /v1/admin/settings` returns four null/version-0 groups. Collect approved BI-01 brand/domain/legal/contact copy, BI-09 WhatsApp number/wording and remaining BI-07 notification recipients first. Do not copy prototype/demo defaults.

Use the actual admin origin, `settings.manage` session and JSON `PATCH /v1/admin/settings` with `{key, version, value}`. Version 0 creates an absent key; use the returned version for subsequent changes, and reload on 409. Send the complete typed value for the selected key; null explicitly clears it without deleting history. Optional contacts/social/template values are nullable. Email recipients are capped at ten and unique case-insensitively; enabled new-order email requires recipients. Low-stock/daily email, provider credentials and arbitrary setting keys are rejected. Preserve IDs/version/request audit evidence without copying private configuration into incident notes.

Saving values does not activate email/WhatsApp automation. Provider credentials/origins, default-off/staging allowlists and delivery provisioning remain separate. Future notification/link consumers must validate approved settings and escape template values. Settings UI is step 40; the launch sequence above covers the real bootstrap. No real configuration/migration was performed by step 38 tests.

## Approved delivery configuration (step 39)

Deploy migration `20261010000300_delivery_configuration`; collect BI-03 approved area names/codes, coverage/exclusions, one flat fee and ETA first. No prototype seeds are installed. Initially `GET /v1/admin/delivery-areas` is empty and `/configuration` returns null/version 0. Use an actual admin-origin Owner session with `delivery.manage`; all bodies are strict JSON.

Create each approved area with `POST /v1/admin/delivery-areas` `{code,name,active}` (201, version 1). Codes are immutable lower-case identifiers; names are unique case-insensitively. List via bounded `limit`/`after` cursor. Change name/active via `PATCH /:id` `{version,name,active}`; deactivate rather than delete. Configure `/configuration` with `PATCH` `{version,value:{flatFeeFils,etaText,freeThresholdFils:null}}`; version 0 is only for an absent row, and `value:null` clears while retaining version history. Reload on 409 rather than silently overwriting another operator. One fee applies to every active area; free delivery stays disabled.

This does not validate a typed address's boundary, enable checkout or create orders. Admin forms are step 40 and quote/order acceptance is later commerce work. No real coverage/fee/ETA or live migration was applied by the step-39 tests.
