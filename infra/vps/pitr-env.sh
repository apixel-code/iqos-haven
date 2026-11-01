#!/bin/sh
# One-time setup for point-in-time recovery copies (step 122c): this environment's own rclone
# "crypt" remote (pitr-<env>, own folder and own keys) over the existing gdrive remote, so WAL segments and base backups (which hold customer data) are
# encrypted before they leave this server. Prints no secret; the passwords are written to
# env/pitr.env (0600), which the operator copies OFF this server (password manager).
set -eu
cd "$(dirname "$0")"
env="$(basename "$(pwd)")"
[ ! -e env/pitr.env ] || { echo "env/pitr.env exists; refusing to replace the keys" >&2; exit 2; }
rclone listremotes | grep -qx 'gdrive:' || { echo "rclone remote gdrive: missing" >&2; exit 2; }
umask 077
pw="$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n')"
salt="$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n')"
printf 'PITR_CRYPT_PASSWORD=%s\nPITR_CRYPT_SALT=%s\n' "$pw" "$salt" > env/pitr.env
! rclone listremotes | grep -qx "pitr-$env:" || { echo "remote pitr-$env: exists" >&2; exit 2; }
rclone config create "pitr-$env" crypt remote="gdrive:iqos-haven-pitr-$env" \
  password="$pw" password2="$salt" --obscure >/dev/null
mkdir -p wal basebackups && chown 70:70 wal && chmod 700 wal basebackups
echo "Created rclone remote pitr-$env: (encrypted). Save both values off this server now:"
echo "  cat $(pwd)/env/pitr.env"
