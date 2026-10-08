# 0003 — Restore approved database and API stack

- Date: 2026-10-08
- Status: accepted for corrected baseline
- Supersedes: ADR 0002

The supplied architecture explicitly selects Prisma + PostgreSQL 18 and NestJS + Fastify. The initial scaffold changed that choice without approval. Restore the source-of-truth stack instead of retaining an undocumented architectural fork.

Prisma 7 uses the pg driver adapter and an explicitly generated CommonJS client. The intentionally empty Prisma schema supports raw operations and future reviewed models without fake business tables. Parameterized `Prisma.sql`/tagged queries provide explicit PostgreSQL locking inside Read Committed interactive transactions. Canonical ordering and constraints remain mandatory; switching ORMs alone does not establish correctness.

Only whole-transaction deadlock/serialization retries are permitted, bounded at three attempts with jitter. Unique conflicts and permanent errors are not retried. Migrations use separate owner credentials and fail for absent/empty/incomplete sets outside explicit local development no-op. API uses Fastify; HTTP fixtures verify validation and safe envelope behavior. PostgreSQL 18 Compose mounts the version-aware `/var/lib/postgresql` parent and a new volume name, avoiding accidental PG17 data-directory reuse.

Business models, concurrency acceptance and provider deployment remain pending.
