# Environment matrix

`NODE_ENV` is development/test/production. `APP_ENV` identifies development/test/staging/production; production Node mode requires explicit APP_ENV=staging or production. Next production builds/start use NODE_ENV=production even on staging. Platform secrets are injected; `.env` loads only for local development/tests, never for production Node mode or staging/production APP_ENV.

## Consumed by this foundation

| Variable                                       | Consumer                                   | Default / requirement                                                  |
| ---------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| NODE_ENV / APP_ENV / LOG_LEVEL                 | Config/API/worker/Next launchers           | Explicit production deployment identity; safe level                    |
| DATABASE_URL / DATABASE_POOL_MAX               | API/worker Prisma adapter/pg pool          | Runtime role, max API 10 / worker 5                                    |
| DATABASE_MIGRATION_URL                         | Migration wrapper/Prisma CLI configuration | Owner URL required for migrate; generation uses an inert URL if absent |
| DATABASE_TEST_URL                              | Integration harness                        | Dedicated *_test DB; local ih_test role, isolated schema per run       |
| QUEUE_REDIS_URL                                | API readiness/worker                       | Separate noeviction queue; not catalogue cache                         |
| API_PORT / API_HOST                            | API                                        | 4000 / 127.0.0.1 locally; container private bind 0.0.0.0               |
| WORKER_CONCURRENCY / WORKER_STARTUP_TIMEOUT_MS | Worker                                     | 4 / 15000; bounded startup and 20s shutdown                            |
| STOREFRONT_PORT / ADMIN_PORT                   | Next launchers                             | 3000 / 3001; changing example values now affects launch                |
| API_INTERNAL_URL                               | Next startup schemas                       | Required HTTP(S); reserved for the later same-origin gateway consumer  |

The root launch helper resolves compiled @ih/config. Run pnpm build before pnpm dev/start. Front-end build uses no DB/queue credentials. Turbo explicitly passes runtime/test variables through strict env mode; it does not put secrets into build inputs or browser public variables.

## Reserved, not consumed yet

S3_ENDPOINT/REGION/ACCESS_KEY/SECRET_KEY/BUCKET_* and SMTP_HOST/PORT/EMAIL_FROM/EMAIL_SEND_ENABLED in `.env.example` are future adapter inputs. Current code sends no emails/uploads. Add adapter-specific schema and boolean parsing in the same change as the consumer; do not use Boolean("false"). Staging recipients and sender allowlists are release controls.

Future signing/confirmation/session/gateway/cache/provider secrets must follow `runbooks/secrets-and-keys.md`; do not invent working keys in this package. No NEXT_PUBLIC secret, migration credential or signing private key. Runtime/migration/test and environment credentials remain separate. APP_ENV never authorizes an endpoint or substitutes for age/RBAC.

## Local infrastructure

Compose binds Postgres, queue Redis, MinIO and Mailpit host ports only to loopback. PostgreSQL 18 uses its version-specific Docker data layout and a new pg18-data volume; do not mount a PG17 volume into it or delete an old volume as an upgrade method. Use logical dump/restore or an approved major-upgrade procedure.

`infra/images.lock.json` records pinned references. Postgres/Redis/Node/Mailpit digests were fetched from the registry; MinIO/mc use official versioned Quay references. Quay digest resolution and all Docker runtime checks are pending this environment's capabilities. All of these Compose credentials are local fixtures, never production credentials. Production storage is the selected approved UAE-region provider, not this dev MinIO instance.
