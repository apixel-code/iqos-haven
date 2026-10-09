# Secrets and key lifecycle

Status: operational procedure for implementation; no production keys exist in this ZIP. Record chosen manager, service identity, operators and evidence after BI-06/provider approval. Never paste a secret into docs/CLI logs/chat/build arguments. Record only key IDs, timestamps and encrypted-manager references.

## Purpose/access matrix

| Purpose                                  | Allowed reader/writer                     | Storage/rotation control                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Age Ed25519 private signer               | Storefront server age-accept handler only | Secret manager/service identity; never API/browser/build                                                                                                                      |
| Age public verification set              | Storefront verifier/API                   | Allowlisted kid/algorithm/issuer/audiences/policy; no token-controlled key URL                                                                                                |
| Signed quote key                         | API pricing/checkout                      | Separate purpose/key and lifetime from age                                                                                                                                    |
| Confirmation replay encryption           | API idempotency/cookie response           | Encrypted token material expires with capability; store only verifier hash on order                                                                                           |
| Internal invalidation/gateway identity   | Specific service-to-service callers       | `INTERNAL_SERVICE_KEYS` on the verifier, one `service:keyId` per caller; rotate by adding the new key id to the verifier, then switching the caller, then removing the old id |
| Session/reset/invite/confirmation tokens | Issuing API and scoped consumer           | Random opaque secret, hashed verifier; session/one-time/expiry rules                                                                                                          |
| Runtime DB                               | API/worker                                | Least privilege, no DDL; app connection pool drain on rotation                                                                                                                |
| Migration DB                             | One release migration job                 | Owner role; absent from front ends/runtime containers                                                                                                                         |
| Test DB                                  | Isolated test jobs                        | Cannot connect to live DB; dedicated *_test database                                                                                                                          |
| Queue/cache/storage/email                | Only relevant adapters/services           | Separate environment/purpose credentials; least privilege                                                                                                                     |

## Normal age-key rotation

1. Provision a new key in the secret manager; assign a new kid and note maximum ticket lifetime/skew.
2. Publish its public key to every API/storefront verifier. Verify readiness/allowlist on all replicas before changing the signer.
3. Switch only the storefront signer to the new private key. Record switch time and latest possible expiry for previous tickets.
4. Keep old public key valid through the last old-ticket expiry plus skew. At proposed 30-day memory, overlap may last 30 days; a few minutes is insufficient.
5. Keep old private key only for the controlled rollback window, then retire it. Retire old public key only after expiry window.
6. Run forgery/wrong-audience/unknown-kid/expired-policy and dual-key regression checks; record evidence.

## Compromise/revocation

Revoke compromised kid immediately across every verifier; do not use the normal overlap. Re-gate affected visitors; rotate dependent service credentials if exposed. Check logs/telemetry and browser/build artifacts for disclosure without printing secrets. Snapshot safe evidence, notify the designated operator, record incident timeline and validate all replicas before resuming.

## Other credential rotation/recovery

Use provider-supported staged credentials/identity rotation, deploy readers, verify health and revoke old credentials after the controlled window. Confirmation-encryption-key removal needs a deliberate replay-expiry/recovery policy so accepted orders are never duplicated. Keep secret-manager recovery permissions separately controlled/tested; bootstrap Owner recovery is audited and never adds a default password. Every environment has independent secrets/state/backup access.
