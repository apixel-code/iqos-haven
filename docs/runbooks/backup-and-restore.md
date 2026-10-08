# Backup and isolated restore drill

Architecture targets: DB RPO≤5 minutes, RTO≤1 hour, initial PITR retention 14 days. These are release targets, not measured achievements. Configure only after verifying actual provider capability/cost/region and client retention/data-flow approval.

1. Record DB/media/infrastructure backup IDs, restore timestamp, operator, chosen profile and start time. Verify encryption/access, S3 versioning/lifecycle and separate recovery permissions.
2. Restore DB and needed media into independent isolated state/network. Use new test credentials; disable external sends/schedulers/customer callbacks and prevent restored API from being public.
3. Validate migrations/schema/version, sampled immutable order/item/tax/customer snapshots, variant balances versus stock ledger, coupon counts and COD collection history. Record mismatch IDs, not PII.
4. Discover unfinished durable effects, avoid active lease duplication, rebuild disposable queue state. Never erase idempotency/effect records to make the drill look successful.
5. Verify actual backup/data timestamp gap (RPO), duration to healthy authorized operations (RTO), media accessibility and operator/key recovery. Record failures honestly.
6. Reconcile drill state without sending customer notifications. Approve any intentional provider replay separately; measure recovery after each material backup change and at least quarterly.
7. Clean up only the isolated drill environment under its explicit inventory; never run volume deletion/drop/reset against production.

Store measured evidence and exception decisions with the release. A healthy Redis snapshot alone does not back up accepted orders.
