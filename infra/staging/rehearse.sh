#!/bin/sh
# Release rehearsal (roadmap step 128) BEFORE a real deploy, on a copy of this environment's data:
#
#   ./rehearse.sh releases/<new>.env [releases/<old>.env]    (old defaults to release.current.env)
#
# 1. a fresh encrypted backup, restored into an isolated drill database (ADR 0098);
# 2. the NEW release's migrations applied to that copy with the migration identity;
# 3. the OLD api started against the migrated copy (runtime role, throwaway Redis) and its
#    readiness checked: proof that rolling the app back after this release is safe;
# 4. the NEW api started against the same copy and checked the same way.
# Live data, the live queue and live containers are never touched; everything is removed after.
set -eu
umask 077
cd "$(dirname "$0")"
new="${1:?usage: rehearse.sh <new-release.env> [<old-release.env>]}"
old="${2:-release.current.env}"
image() { grep -E "^$1=" "$2" | cut -d= -f2-; }
C="docker compose --env-file release.current.env"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$($C ps -q postgres)")"
tag="rehearse-$$"
drill=""
cleanup() {
  docker rm -f "ih-$tag-api" "ih-$tag-redis" >/dev/null 2>&1 || true
  rm -f "env/.$tag.env"
  [ -z "$drill" ] || $C --profile ops run --rm ops node dist/cli/restore-drill.main.js --drop "$drill" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 1. Fresh backup and isolated copy"
$C --profile ops run --rm ops node dist/cli/backup.main.js | grep -E "^Backup set|^Database"
set_name="$(ls -1d backups/ih-backup-* | sort | tail -1 | xargs basename)"
drill="$($C --profile ops run --rm ops node dist/cli/restore-drill.main.js "$set_name" --keep \
  | sed -n 's/^Restored into \(iqos_haven_drill_[0-9]*\).*/\1/p')"
[ -n "$drill" ] || { echo "FAIL: restore drill did not produce a copy" >&2; exit 1; }
echo "copy: $drill"
$C exec -T postgres psql -U ih_owner -d postgres -qc "GRANT CONNECT ON DATABASE \"$drill\" TO ih_app"

# Environment for the throwaway containers: the same files, pointed at the copy and a private Redis.
sed "s#\(postgres://[^@]*@postgres:5432/\)iqos_haven\$#\1$drill#" env/migrate.env > "env/.$tag.env"
echo "== 2. New release's migrations on the copy"
out="$(docker run --rm --network "$network" --env-file "env/.$tag.env" "$(image IH_IMAGE_MIGRATE "$new")" 2>&1)" \
  || { printf '%s\n' "$out" | tail -5 >&2; echo "FAIL: migrations did not apply to the copy" >&2; exit 1; }
printf '%s\n' "$out" | grep -iE "migration|applied|pending" | tail -3

docker run -d --rm --name "ih-$tag-redis" --network "$network" \
  "$($C config --images redis-queue | head -1)" redis-server --maxmemory-policy noeviction >/dev/null
sed -e "s#\(postgres://[^@]*@postgres:5432/\)iqos_haven\$#\1$drill#" \
  -e "s#^QUEUE_REDIS_URL=.*#QUEUE_REDIS_URL=redis://ih-$tag-redis:6379#" env/api.env > "env/.$tag.env"
check_api() {
  docker rm -f "ih-$tag-api" >/dev/null 2>&1 || true
  docker run -d --name "ih-$tag-api" --network "$network" --env-file "env/.$tag.env" "$2" >/dev/null
  i=0
  until docker exec "ih-$tag-api" node -e "fetch('http://127.0.0.1:4000/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || { docker logs --tail 15 "ih-$tag-api" >&2; echo "FAIL: $1 api not ready on the migrated copy" >&2; exit 1; }
    sleep 1
  done
  echo "PASS $1 api ready on the migrated schema ($(image IH_IMAGE_API "$3" | cut -c1-80)…)"
}
echo "== 3. Previous app on the new schema (rollback safety)"
check_api old "$(image IH_IMAGE_API "$old")" "$old"
echo "== 4. New app on the new schema"
check_api new "$(image IH_IMAGE_API "$new")" "$new"
echo "Rehearsal passed: $(head -1 "$new") can be released, and rolled back to $(head -1 "$old")."
