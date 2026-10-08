# packages/db — schema, migrations, transaction context

- Migrations are forward-only, expand → deploy → contract. Each must run on a clean DB and be backwards compatible with the previous app version.
- Put real constraints in the DB: unique SKU/slug/option signature, CHECK nonnegative stock and money bounds, FK with explicit ON DELETE (history never cascades).
- Money columns: integer (bigint) fils. Timestamps: timestamptz, UTC; report in Asia/Dubai.
- Every mutable aggregate has a `version` column for optimistic concurrency.
- Runtime DB role ≠ migration role.
- Table introduction order follows the "Database migration rollout" table in `docs/roadmap.md`. Don't create FKs to tables that don't exist yet.
- Never read generated client output or migration snapshots into context; read the schema source.
