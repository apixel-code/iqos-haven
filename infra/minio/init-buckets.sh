#!/bin/sh
# Local development only. Propagate bucket errors; never report false success.
set -eu
retries="${MINIO_INIT_RETRIES:-30}"
case "$retries" in ''|*[!0-9]*) echo "Invalid retry budget" >&2; exit 1;; esac
[ "$retries" -gt 0 ] && [ "$retries" -le 120 ] || exit 1
attempt=0
until mc alias set local "${MINIO_ENDPOINT:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt "$retries" ] || { echo "MinIO did not become ready" >&2; exit 1; }
  sleep 1
done
for bucket in ih-quarantine ih-media ih-reports; do
  mc mb --ignore-existing "local/$bucket"
  mc stat "local/$bucket"
done
