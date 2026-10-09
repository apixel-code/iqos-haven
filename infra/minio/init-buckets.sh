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
  # Private: no anonymous (public) access to any object.
  mc anonymous set none "local/$bucket"
  mc stat "local/$bucket"
done
# Least-privilege service identity used by api/worker instead of the root account:
# object read/write/delete in the three buckets only; no bucket, policy or admin rights.
if [ -n "${MINIO_SERVICE_USER:-}" ]; then
  policy="${TMPDIR:-/tmp}/ih-service-objects.json"
  cat > "$policy" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::ih-quarantine/*",
        "arn:aws:s3:::ih-media/*",
        "arn:aws:s3:::ih-reports/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::ih-quarantine",
        "arn:aws:s3:::ih-media",
        "arn:aws:s3:::ih-reports"
      ]
    }
  ]
}
JSON
  mc admin user add local "$MINIO_SERVICE_USER" "$MINIO_SERVICE_PASSWORD"
  mc admin policy create local ih-service-objects "$policy"
  # Attach fails harmlessly when already attached on a re-run; the check below is authoritative.
  mc admin policy attach local ih-service-objects --user "$MINIO_SERVICE_USER" || true
  mc admin user info local "$MINIO_SERVICE_USER" | grep -q "ih-service-objects" ||
    { echo "Service policy not attached" >&2; exit 1; }
fi
