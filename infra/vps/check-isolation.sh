#!/bin/sh
# Proves two environments share no credential (roadmap steps 123/128: "production credentials
# isolated"): no password, secret, key ring, signing key or database URL value appears in both.
# Prints counts only, never values. Exit 0 isolated, 1 a shared value, 2 nothing to compare.
#
#   ./check-isolation.sh /opt/iqos-staging /opt/iqos-production
set -eu
a="${1:?usage: check-isolation.sh <env-dir> <env-dir>}"
b="${2:?usage: check-isolation.sh <env-dir> <env-dir>}"
secrets() {
  cat "$1"/env/*.env | grep -E '^[A-Z0-9_]*(PASSWORD|SECRET_KEY|_KEY|_KEYS|SALT|_URL)=' \
    | grep -vE '^(S3_ACCESS_KEY|API_INTERNAL_URL|S3_ENDPOINT|S3_PUBLIC_ENDPOINT|QUEUE_REDIS_URL|RESEND_API_URL|SYNTHETIC_[A-Z_]+_URL|PASSWORD_RESET_ORIGIN)=' \
    | sort -u
}
for dir in "$a" "$b"; do
  ls "$dir"/env/*.env >/dev/null 2>&1 || { echo "FAIL: no env files in $dir/env" >&2; exit 2; }
  [ "$(secrets "$dir" | wc -l)" -gt 0 ] || { echo "FAIL: no secret variables found in $dir" >&2; exit 2; }
done
shared=$( (secrets "$a" | cut -d= -f2- | sort -u; secrets "$b" | cut -d= -f2- | sort -u) | sort | uniq -d | wc -l)
count=$(secrets "$a" | wc -l | tr -d " ")
if [ "$shared" -ne 0 ]; then
  echo "FAIL: $shared secret value(s) appear in both environments; regenerate one side" >&2
  exit 1
fi
echo "Isolated: $count secret variables in $(basename "$a"), none shared with $(basename "$b")."
