#!/bin/sh
# Ships archived WAL off-server (step 122c), every 2 minutes from the ih-wal@<env> timer.
# this environment's rclone crypt remote (pitr-<env>) encrypts each segment before upload. Local segments are removed only
# after they are confirmed remotely and 2 days old (fast local restores); remote ones after 15
# days, beyond the 14-day PITR window (architecture §15).
set -eu
cd "$(dirname "$0")"
env="$(basename "$(pwd)")"
remote="pitr-$env:$env/wal"
rclone copy wal "$remote" --exclude '*.tmp' --min-age 10s --immutable
rclone move wal "$remote" --exclude '*.tmp' --min-age 48h --immutable
if [ "$(date -u +%H)" = 00 ] && [ "$(date -u +%M)" -lt 02 ]; then
  rclone delete "$remote" --min-age 15d
fi
