#!/bin/sh
# Release one environment on the VPS (roadmap steps 122/128, ADR 0100). Run from /opt/iqos-<env>:
#
#   ./deploy.sh releases/<sha>.env
#
# The release file comes from the Images workflow and pins every image by digest; site.env holds
# this environment's project name, hostnames, ports and network. Order: state services → buckets
# → reviewed migrations (owner identity, one-shot) → api → worker and web → gateway, then local
# smoke checks. Never removes volumes; a failed step stops the release.
set -eu
umask 077
cd "$(dirname "$0")"
release="${1:?usage: deploy.sh <release.env>}"
[ -d env ] || { echo "env/ missing: run make-env.mjs first" >&2; exit 2; }
[ -f site.env ] || { echo "site.env missing: copy site.<env>.env" >&2; exit 2; }
for var in IH_IMAGE_MIGRATE IH_IMAGE_API IH_IMAGE_WORKER IH_IMAGE_STOREFRONT IH_IMAGE_ADMIN IH_IMAGE_OPS; do
  grep -Eq "^$var=[^ ]+@sha256:[0-9a-f]{64}$" "$release" \
    || { echo "$var is not pinned by digest in $release" >&2; exit 2; }
done
. ./site.env
# Postgres (uid 70 in the image) archives WAL into ./wal; Docker would create it root-owned and
# every archive attempt would fail while pg_wal grows (step 122c).
mkdir -p wal backups && chown 70:70 wal && chown 1000:1000 backups && chmod 700 wal backups
joined=".release.next.env"
cat site.env "$release" > "$joined"
compose() { docker compose --env-file "$joined" "$@"; }

compose --profile migrate --profile ops pull --quiet
compose up -d --wait postgres redis-queue minio
[ "$IH_MAILSINK" != 1 ] || compose --profile mailsink up -d --wait mailpit
compose run --rm minio-init
compose --profile migrate run --rm migrate
compose up -d --wait api
compose up -d --wait worker storefront admin gateway

check() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $2" "http://127.0.0.1:$1$3")
  [ "$code" = "$4" ] || { echo "FAIL $2$3 → $code (want $4)" >&2; return 1; }
  echo "ok   $2$3 → $code"
}
check "$IH_PORT_STORE" "$IH_HOST_STORE" /health 200
check "$IH_PORT_ADMIN" "$IH_HOST_ADMIN" /health 200
check "$IH_PORT_STORE" "$IH_HOST_STORE" /api/v1/admin/staff 404
mv "$joined" release.current.env
echo "Released $(grep '^# Release' "$release") to $IH_PROJECT"

# Old release images (ADR 0109): each release pulls six images (~3 GB), and nothing removed them,
# so the disk filled. After a good release, remove this app's images that no container on this
# host runs (staging and production share the daemon) and that the newest IH_KEEP_RELEASES release
# files (default 2: this one and the one before, for a rollback) do not name. Other images
# (postgres, redis, minio, caddy, mailpit) are never touched. Images stay in GHCR by digest, so an
# older release can still be deployed: it is pulled again. A failure here never fails the release.
prune_images() {
  keep=".release.keep"
  # Full image IDs of every container on this host, running or stopped, of any project.
  docker ps -aq | xargs -r docker inspect --format '{{.Image}}' > "$keep"
  # shellcheck disable=SC2012 # release names are hex hashes, ls -t is safe
  ls -t releases/*.env 2>/dev/null | head -n "${IH_KEEP_RELEASES:-2}" | while read -r file; do
    sed -n 's/^IH_IMAGE_[A-Z]*=//p' "$file"
  done >> "$keep"
  removed=0
  docker images --digests --no-trunc --format '{{.Repository}} {{.Digest}} {{.ID}}' \
    | grep '^ghcr.io/apixel-code/iqos-haven-' > .release.images || true
  while read -r repo digest id; do
    grep -qxF "$repo@$digest" "$keep" && continue
    grep -qxF "$id" "$keep" && continue
    docker rmi "$id" > /dev/null 2>&1 && removed=$((removed + 1))
  done < .release.images
  rm -f "$keep" .release.images
  echo "Removed $removed old release image(s); kept the newest ${IH_KEEP_RELEASES:-2} releases and every image in use"
}
prune_images || echo "Image clean-up skipped (the release itself succeeded)" >&2
