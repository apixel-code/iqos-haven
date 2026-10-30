#!/bin/sh
# Staging/production database roles (step 122): the runtime role is separate from the owner that
# runs migrations, as in infra/postgres/init for local development, but with a generated
# password from the env file instead of a committed one. Runs once, on an empty data volume.
set -eu
: "${IH_APP_PASSWORD:?IH_APP_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 -v app_password="$IH_APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE ih_app LOGIN PASSWORD :'app_password';
REVOKE CONNECT ON DATABASE iqos_haven FROM PUBLIC;
GRANT CONNECT ON DATABASE iqos_haven TO ih_app;
GRANT USAGE ON SCHEMA public TO ih_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ih_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ih_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ih_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ih_app;
SQL
