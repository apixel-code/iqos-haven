#!/bin/sh
# Weekly physical base backup for point-in-time recovery (step 122c), from the
# ih-basebackup@<env> timer. Taken inside the Postgres container (local replication), WAL left
# to the archive (-X none). Copied through the encrypted gcrypt remote; the newest local copy
# is kept for fast restores. Remote base backups older than 15 days are removed.
set -eu
cd "$(dirname "$0")"
remote="gcrypt:$(basename "$(pwd)")/base"
name="base-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose --env-file release.current.env exec -T postgres \
  pg_basebackup -U ih_owner -D - -Ft -X none -c fast | gzip > "basebackups/$name.tmp"
mv "basebackups/$name.tmp" "basebackups/$name"
rclone copy "basebackups/$name" "$remote" --immutable
ls -1 basebackups/base-*.tar.gz | sort | head -n -1 | xargs -r rm -f
rclone delete "$remote" --min-age 15d
echo "Base backup $name copied to $remote"
