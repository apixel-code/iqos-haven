# Age-ticket keys: provisioning, rotation and revocation

Applies to the Ed25519 age-ticket key ring (ADR 0024, architecture §9). The private key belongs to the storefront service only. The API and the storefront verify with public keys.

Record for every key: key id, date it started signing, date it stopped signing, latest possible ticket expiry (stop date + `AGE_TICKET_TTL_DAYS`), and who holds access.

## First provisioning

1. Run `pnpm age:keygen <kid>` on a trusted machine. Nothing is written to disk; do not paste the output into chat, tickets or logs.
2. Put `AGE_TICKET_KEY_ID` and `AGE_TICKET_PRIVATE_KEY` in the storefront's secret store only.
3. Put `AGE_TICKET_PUBLIC_KEYS=<kid>:<public>` in the API and storefront configuration.
4. Set `AGE_POLICY_VERSION` to the approved version (BI-04). Production refuses `unapproved`.
5. Start the API, then the storefront. The API, worker and admin refuse to start in staging or production if they can see the private key.

The storefront refuses to start when its private key does not match the public key listed under its key id, and staging/production refuse to start without keys. A start-up failure naming `AGE_TICKET_*` therefore means the configuration is inconsistent, not that the service is broken.

## Planned rotation

1. Generate the new pair.
2. Append the new public entry to `AGE_TICKET_PUBLIC_KEYS` on the API and the storefront. Deploy and confirm every replica is running with both keys.
3. Switch the storefront's `AGE_TICKET_KEY_ID` and `AGE_TICKET_PRIVATE_KEY` to the new pair. Deploy. Record the switch time.
4. Keep the old private key only for the agreed rollback window, then delete it from the secret store.
5. Keep the old public entry until the switch time + `AGE_TICKET_TTL_DAYS` + 1 day, then remove it. With 30-day tickets this overlap is about a month.

Rolling back during step 3: restore the old signer values. Both public keys are still listed, so tickets from either key verify.

## Compromised key

1. Remove its public entry from `AGE_TICKET_PUBLIC_KEYS` on the API and the storefront at once and deploy. Every ticket signed with it stops verifying; those shoppers pass the gate again.
2. If it was the signing key, provision a new pair first (steps 1–3 above) so new acceptances keep working.
3. Delete the private key from the secret store and record the incident.

## Policy change

Changing `AGE_POLICY_VERSION` on the verifiers refuses every ticket issued for the previous version. Change it on the storefront and the API in the same release.
