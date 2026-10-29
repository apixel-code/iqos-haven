# Backup and isolated restore drill

Architecture targets: DB RPO ≤5 minutes, RTO ≤1 hour, initial PITR retention 14 days. These are release targets, not measured achievements. Design: ADR 0098.

## Setup (once per environment)

1. Generate the key: `pnpm ops:backup-key`. Store `BACKUP_ENCRYPTION_KEY` in the secret store, apart from the backups. Without it nothing can be restored.
2. Set the following (see `.env.example`):
   - `DATABASE_MIGRATION_URL` (owner role);
   - `BACKUP_DIR` (outside the repo on the VPS);
   - `BACKUP_RETENTION_DAYS` (30, BI-08);
   - `BACKUP_POSTGRES_SERVICE` (Compose service, default `postgres`);
   - the storage variables (media bucket).
3. On the VPS (step 122):
   - schedule `pnpm ops:backup` daily (cron or systemd timer);
   - copy each set off the VPS to the approved destination;
   - set up continuous WAL archiving (PITR, 14 days) for the ≤5 min RPO.
   - A daily dump alone allows up to 24 h of loss.

On the VPS the same commands run in the `ops` image (`BACKUP_PG_TOOLS=local`: its own PostgreSQL 18 client), scheduled by a systemd timer and copied to Google Drive; see staging.md "Backups".

## Backup

`pnpm ops:backup`: writes `BACKUP_DIR/ih-backup-<UTC time>/` with these files:

- `database.dump.enc`;
- `media/*.enc`;
- `media-index.enc`;
- `manifest.json`: counts, totals and checksums only.

It then removes sets past retention; the newest set always stays.

- Exit 0 means the set was written.
- Any error exits 2 and leaves older sets untouched.

## Restore drill (before launch, quarterly, and after any backup change)

1. Record the set name, operator and start time.
2. Run `pnpm ops:restore-drill <ih-backup-…>` (add `--keep` to inspect the copy afterwards).
   - It refuses a wrong key or an altered file before creating anything.
   - It restores into a new `iqos_haven_drill_<time>` database and `BACKUP_DIR/drills/<db>/`.
   - No API, worker, scheduler or email send is started.
3. Read the report, which is also saved in `drill-report.json`:
   - migration head;
   - order count and total (fils);
   - collected orders;
   - variants, stock and stock movements;
   - every variant's stock against its ledger;
   - coupon redemptions;
   - unfinished effects;
   - referenced images present and intact.
   - Any FAIL means exit 1: record it with the mismatch names, never PII.
4. Unfinished effects (WARN):
   - reconcile them; do not delete or replay them in the drill;
   - an intentional provider replay needs separate approval, with sends enabled on purpose;
   - never erase idempotency or effect records to make a drill look successful.
5. Record the measured values:
   - RTO, from start to verified;
   - backup age at restore;
   - for PITR, the gap between the last committed write and the recovery point.
6. Clean up:
   - without `--keep`, the drill database and folder are dropped automatically;
   - otherwise run `pnpm ops:restore-drill --drop iqos_haven_drill_<time>`;
   - only drill names can be dropped. Never run volume deletion/drop/reset against production.

## Real restore (incident)

1. Stop the API and worker. Restore into a new database with the drill command and `--keep`, and check the report.
2. Point `DATABASE_URL`/`DATABASE_MIGRATION_URL` at it, using a renamed database or new credentials.
3. Copy the drill media folder back into the media bucket.
4. Start the API, then the worker, and reconcile unfinished effects before sending anything.

Store measured evidence and exception decisions with the release. A healthy Redis snapshot alone does not back up accepted orders.
