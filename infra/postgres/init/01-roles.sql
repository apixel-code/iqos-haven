-- Local dev only: separate runtime role from the migration/owner role (architecture: runtime ≠ migration credentials).
CREATE ROLE ih_app LOGIN PASSWORD 'ih_app_dev';
REVOKE CONNECT ON DATABASE iqos_haven FROM PUBLIC;
GRANT CONNECT ON DATABASE iqos_haven TO ih_app;
GRANT USAGE ON SCHEMA public TO ih_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ih_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ih_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ih_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ih_app;

-- Separate database for integration tests.
CREATE ROLE ih_test LOGIN PASSWORD 'ih_test_dev';
CREATE DATABASE iqos_haven_test OWNER ih_test;
REVOKE CONNECT ON DATABASE iqos_haven_test FROM PUBLIC;
GRANT CONNECT ON DATABASE iqos_haven_test TO ih_test;
