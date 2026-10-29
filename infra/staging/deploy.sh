#!/bin/sh
# Staging release (roadmap step 122, ADR 0100). Run on the server from the staging directory:
#
#   ./deploy.sh release.env
#
# release.env comes from the Images workflow and pins every image by digest. Order: state
# services → buckets → reviewed migrations (owner identity, one-shot) → api → worker and web →
# gateway, then local smoke checks. Never removes volumes; a failed step stops the release.
set -eu
cd "$(dirname "$0")"
release="${1:?usage: deploy.sh <release.env>}"
[ -d env ] || { echo "env/ missing: run make-env.mjs first" >&2; exit 2; }
for var in IH_IMAGE_MIGRATE IH_IMAGE_API IH_IMAGE_WORKER IH_IMAGE_STOREFRONT IH_IMAGE_ADMIN IH_IMAGE_OPS; do
  grep -Eq "^$var=[^ ]+@sha256:[0-9a-f]{64}$" "$release" \
    || { echo "$var is not pinned by digest in $release" >&2; exit 2; }
done
compose() { docker compose --env-file "$release" "$@"; }

compose --profile migrate --profile ops pull --quiet
compose up -d --wait postgres redis-queue minio mailpit
compose run --rm minio-init
compose --profile migrate run --rm migrate
compose up -d --wait api
compose up -d --wait worker storefront admin gateway

check() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $2" "http://127.0.0.1:$1$3")
  [ "$code" = "$4" ] || { echo "FAIL $2$3 → $code (want $4)" >&2; return 1; }
  echo "ok   $2$3 → $code"
}
check 8180 storefront /health 200
check 8181 admin /health 200
check 8180 storefront /api/v1/admin/staff 404
cp "$release" release.current.env
echo "Released $(head -1 "$release")"
