#!/bin/sh
# Creates env/backup.env for the ops image (step 122b): the migration identity and storage
# variables already on this server, plus a NEW backup encryption key. Prints no secret.
# Afterwards the operator copies the key OFF this server (password manager): the Google Drive
# copies are useless without it, and a key kept only here dies with the server.
set -eu
cd "$(dirname "$0")"
[ ! -e env/backup.env ] || { echo "env/backup.env exists; refusing to replace the key" >&2; exit 2; }
umask 077
{
  grep -E '^(NODE_ENV|APP_ENV|LOG_LEVEL|DATABASE_MIGRATION_URL)=' env/migrate.env
  grep -E '^S3_' env/worker.env
  echo "BACKUP_DIR=/backups"
  echo "BACKUP_RETENTION_DAYS=30"
  echo "BACKUP_PG_TOOLS=local"
  echo "BACKUP_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
} > env/backup.env
mkdir -p backups && chown 1000:1000 backups && chmod 700 backups
echo "Wrote env/backup.env. Save the key off this server now:"
echo "  grep BACKUP_ENCRYPTION_KEY $(pwd)/env/backup.env"
