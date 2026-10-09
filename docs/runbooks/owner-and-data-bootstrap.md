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
