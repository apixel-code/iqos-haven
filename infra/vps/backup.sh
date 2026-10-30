#!/bin/sh
# Daily encrypted backup and off-server copy (step 122b, ADR 0098/0100). Run by the
# ih-backup@<env> systemd timer. Sets are AES-256-GCM encrypted before they leave the ops
# container; rclone only copies sealed files. Local and remote retention: 30 days (BI-08).
set -eu
cd "$(dirname "$0")"
envname="$(basename "$(pwd)")"
remote="${IH_BACKUP_REMOTE:-gdrive:iqos-haven-backups}/$envname"
C="docker compose --env-file release.current.env"
$C --profile ops run --rm ops node dist/cli/backup.main.js
latest="$(ls -1d backups/ih-backup-* | sort | tail -1)"
rclone copy "$latest" "$remote/$(basename "$latest")" --immutable
rclone delete "$remote" --min-age 31d
rclone rmdirs "$remote" --leave-root
echo "Backed up $(basename "$latest") to $remote"
