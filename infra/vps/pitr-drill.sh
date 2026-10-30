#!/bin/sh
# Point-in-time recovery drill (step 122c): restores the newest base backup plus archived WAL
# up to a target time into a throwaway PostgreSQL container on its own network, then prints
# the recovered row counts and the last committed write (the worker's scheduler writes a
# scheduled_runs row every minute, so its newest row shows the actual recovery point). Nothing is started against it; the
# live database is never touched. The container and its folder are removed afterwards.
#
#   ./pitr-drill.sh ["2026-10-30 10:15:00+00"]   (default: latest available)
#   IH_PITR_FROM_REMOTE=1 ./pitr-drill.sh …        (fetch base + WAL from Google Drive first)
set -eu
cd "$(dirname "$0")"
target="${1:-}"
env="$(basename "$(pwd)")"
work="$(pwd)/drills/pitr-$(date -u +%Y%m%dT%H%M%SZ)"
name="ih-pitr-drill-$$"
image="$(docker compose --env-file release.current.env config --images postgres | head -1)"
mkdir -p "$work/data" "$work/wal"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
if [ -n "${IH_PITR_FROM_REMOTE:-}" ]; then
  base="$(rclone lsf "pitr-$env:$env/base" | sort | tail -1)"
  rclone copy "pitr-$env:$env/base/$base" "$work"
  rclone copy "pitr-$env:$env/wal" "$work/wal"
  basefile="$work/$base"
else
  basefile="$(ls -1 basebackups/base-*.tar.gz | sort | tail -1)"
  cp wal/*.gz "$work/wal/"
fi
started=$(date +%s)
gzip -dc "$basefile" | tar -x -C "$work/data"
touch "$work/data/recovery.signal"
{
  echo "restore_command = 'gzip -dc /wal/%f.gz > %p'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
  fi
  echo "recovery_target_action = 'promote'"
  echo "archive_mode = off"
} >> "$work/data/postgresql.auto.conf"
chown -R 70:70 "$work" && chmod 700 "$work/data"
docker run -d --name "$name" --network none \
  -v "$work/data:/var/lib/postgresql/18/docker" -v "$work/wal:/wal:ro" "$image" >/dev/null
i=0
until docker exec "$name" psql -U ih_owner -d iqos_haven -Atc "select not pg_is_in_recovery()" 2>/dev/null | grep -qx t; do
  i=$((i + 1)); [ "$i" -lt 180 ] || { docker logs --tail 20 "$name" >&2; echo "FAIL: recovery did not finish" >&2; exit 1; }
  sleep 1
done
echo "Recovered in $(( $(date +%s) - started )) s from $(basename "$basefile") (target: ${target:-latest})."
docker exec "$name" psql -U ih_owner -d iqos_haven -At -F ' ' -c "
  select 'orders', count(*)::text from orders union all
  select 'products', count(*)::text from products union all
  select 'variants', count(*)::text from variants union all
  select 'stock_movements', count(*)::text from stock_movements union all
  select 'audit_log', count(*)::text from audit_log union all
  select 'last audit write', max(occurred_at)::text from audit_log union all
  select 'last scheduler heartbeat', max(created_at)::text from scheduled_runs"
echo "PITR drill passed; the drill container and its files are removed."
