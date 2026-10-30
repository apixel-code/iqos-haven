# 0098 — Encrypted backup sets and a measured, isolated restore drill

- Date: 2026-10-25
- Status: accepted
- Step(s): roadmap step 126 (architecture §15, acceptance RESTORE-01)

## Context

Architecture §15 asks for:

- encrypted backups;
- point-in-time recovery (RPO ≤5 min, RTO ≤1 h);
- a restore drill before launch that restores the database and media into an isolated place, reconciles unfinished effects, checks order and stock totals, keeps external sends off and measures RPO and RTO.

The store runs on one Hostinger VPS (BI-06) with PostgreSQL in Docker Compose, so there is no managed backup service. Database backups are kept 30 days (BI-08). The VPS does not exist yet (step 122).

## Decision

- **`pnpm ops:backup`** writes one backup set per run, `BACKUP_DIR/ih-backup-<UTC time>/`.
  - **Database:** `pg_dump --format=custom`, run inside the Compose `postgres` service.
    - It uses a snapshot exported from a REPEATABLE READ transaction (`pg_export_snapshot()`).
    - The manifest facts are read in that same snapshot, so the dump and the facts describe the same committed moment while orders keep arriving.
  - **Media:** every object in the media bucket, each encrypted on its own, with an encrypted index from key to checksum.
    - Quarantine (unprocessed uploads) is not copied.
    - Reports (rebuilt on request) are not copied.
  - **Encryption:** AES-256-GCM with `BACKUP_ENCRYPTION_KEY` (32 bytes, base64url, made by `pnpm ops:backup-key`). Each file has its own random IV and an authenticated header, so a wrong key or a changed byte is refused.
    - The key lives in the secret store, never next to the backups.
  - **Manifest** (`manifest.json`, plain):
    - migration head;
    - order count and total in fils;
    - collected orders;
    - variants, stock on hand, stock movements and ledger mismatches;
    - coupon redemptions;
    - unfinished effects by status;
    - how many images are referenced;
    - each file's SHA-256.
    - Counts and checksums only: no customer data, no object keys.
  - **Permissions:** folders 0700, files 0600.
  - **Retention:** sets older than `BACKUP_RETENTION_DAYS` (default 30, BI-08) are removed after a successful run. The newest set is always kept, and only folders named like a set and holding a manifest are touched.
- **`pnpm ops:restore-drill <set> [--keep]`**:
  1. checks every file against the manifest checksum before decrypting anything;
  2. creates a new database `iqos_haven_drill_<UTC time>` on the same server and runs `pg_restore --no-owner --exit-on-error`;
  3. decrypts the media into `BACKUP_DIR/drills/<db>/media`, checking each checksum;
  4. reads the same facts on the copy and compares them with the manifest (PASS/FAIL), and checks that every referenced image is present and intact;
  5. reports unfinished effects as WARN for reconciliation. They are never replayed or deleted.
  - Nothing is started on the copy: no API, worker, scheduler or email send.
  - It measures the RTO (start to verified) and the backup age at restore, and writes `drill-report.json`.
  - The copy is dropped unless `--keep` is given; `--drop <db>` removes a kept one.
  - Only names matching `^iqos_haven_drill_\d{14}$` can be created or dropped, and the source database is never written.
- **Exit codes:** 0 passed, 1 a check failed, 2 the drill could not run (wrong key, altered file, configuration).

## RPO and RTO

- **RTO:** this drill measures it. Locally the RTO is about 1 s for the seeded data, far under 1 h. It must be measured again on the VPS with production-sized data.
- **RPO:**
  - A nightly dump alone gives an RPO of up to 24 h, which does not meet the ≤5 min target.
  - The ≤5 min RPO needs continuous WAL archiving (PITR, 14 days) on the VPS, for example `archive_command` or pgBackRest to off-VPS object storage. It is set up and measured with step 122.
  - Until then the drill reports the backup age honestly instead of claiming the target.
  - **Update 2026-10-30 (step 122c):** on the VPS, PostgreSQL archives WAL every 2 minutes (`archive_timeout=120`), shipped every 2 minutes through an rclone crypt remote to Google Drive, with weekly `pg_basebackup` base backups. `pitr-drill.sh` restores to a target time from Drive alone (staging runbook). RPO about 4 minutes; PITR window 14 days.

## Consequences

- Off-VPS copies need an approved destination (data-flow policy, architecture §13). The backup folder is local until then.
- The schedule (cron or systemd timer, daily) and copying sets off the VPS are part of step 122. The commands are ready for them.
- A restore always needs `BACKUP_ENCRYPTION_KEY`. Losing it makes every set unreadable, so the key is recovered through the secrets runbook.
- Redis is not backed up: queue state is rebuilt from durable effects (architecture §15).
