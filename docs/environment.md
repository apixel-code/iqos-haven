# Environment matrix

`NODE_ENV` is development/test/production. `APP_ENV` identifies development/test/staging/production; production Node mode requires explicit APP_ENV=staging or production. Next production builds/start use NODE_ENV=production even on staging. Platform secrets are injected; `.env` loads only for local development/tests, never for production Node mode or staging/production APP_ENV.

## Consumed by this foundation

| Variable                                                  | Consumer                                       | Default / requirement                                                                         |
| --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| NODE_ENV / APP_ENV / LOG_LEVEL                            | Config/API/worker/Next launchers               | Explicit production deployment identity; safe level                                           |
| DATABASE_URL / DATABASE_POOL_MAX                          | API/worker Prisma adapter/pg pool              | Runtime role, max API 10 / worker 5                                                           |
| DATABASE_MIGRATION_URL                                    | Migration wrapper/Prisma CLI configuration     | Owner URL required for migrate; generation uses an inert URL if absent                        |
| DATABASE_TEST_URL                                         | Integration harness                            | Dedicated *_test DB; local ih_test role, isolated schema per run                              |
| QUEUE_REDIS_URL                                           | API readiness/worker                           | Separate noeviction queue; not catalogue cache                                                |
| CACHE_REDIS_URL (optional)                                | API/worker schemas (guard only for now)        | Replicated profile only; reject if same host:port as queue (loopback aliases unified)         |
| EMAIL_SEND_ENABLED / EMAIL_FROM                           | Worker email adapter                           | `"true"`/`"false"` only, default off; sender required when on                                 |
| SMTP_HOST / PORT / SECURE / USER / PASSWORD               | Worker SMTP adapter                            | dev/test: local sink only (Mailpit); user+password set together                               |
| EMAIL_PROVIDER / RESEND_API_KEY / RESEND_API_URL          | Worker email adapter (ADR 0004)                | `smtp` default; `resend` needs a `re_…` key; tests may only use a local stub URL              |
| EMAIL_RECIPIENT_ALLOWLIST                                 | Worker email adapter                           | Addresses/@domains; mandatory in staging, and for Resend in development                       |
| MAILPIT_URL                                               | Email integration tests only                   | Mailpit HTTP API, default http://localhost:8025                                               |
| S3_ENDPOINT / S3_REGION / S3_FORCE_PATH_STYLE             | API/worker storage (@ih/platform)              | Local MinIO http + path style; staging/production https (provider BI-06)                      |
| S3_ACCESS_KEY / S3_SECRET_KEY                             | API/worker storage                             | Least-privilege service user (local `ih_service`), never root; omit to use platform identity  |
| S3_BUCKET_QUARANTINE / MEDIA / REPORTS                    | API/worker storage                             | Private buckets; defaults ih-quarantine / ih-media / ih-reports                               |
| INTERNAL_SERVICE_KEYS                                     | API internal-route guard                       | `service:keyId:base64urlSecret` list (≥ 32-byte secrets); empty = every internal route denies |
| INTERNAL_SERVICE_ID / KEY_ID / KEY                        | Worker (and later storefront) signing identity | All three or none; separate secret per caller and environment                                 |
| ARGON2_MEMORY_KIB / ARGON2_TIME_COST / ARGON2_PARALLELISM | API + bootstrap CLI password hashing           | 65536 / 3 / 1 by default; floors 19456 KiB, t=2; tune with `pnpm identity:benchmark`          |
| API_PORT / API_HOST                                       | API                                            | 4000 / 127.0.0.1 locally; container private bind 0.0.0.0                                      |
| WORKER_CONCURRENCY / WORKER_STARTUP_TIMEOUT_MS            | Worker                                         | 4 / 15000; bounded startup and 20s shutdown                                                   |
| STOREFRONT_PORT / ADMIN_PORT                              | Next launchers                                 | 3000 / 3001; changing example values now affects launch                                       |
| API_INTERNAL_URL                                          | Next startup schemas                           | Required HTTP(S); reserved for the later same-origin gateway consumer                         |

The root launch helper resolves compiled @ih/config. Run pnpm build before pnpm dev/start. Front-end build uses no DB/queue credentials. Turbo explicitly passes runtime/test variables through strict env mode; it does not put secrets into build inputs or browser public variables.

## Reserved, not consumed yet

Storage (step 26) and email (step 25) variables are now consumed; see the table above, docs/email-delivery.md and packages/platform/CLAUDE.md. Add adapter-specific schema and boolean parsing in the same change as the consumer; do not use Boolean("false"). Staging recipients and sender allowlists are release controls.

Future signing/confirmation/session/gateway/cache/provider secrets must follow `runbooks/secrets-and-keys.md`; do not invent working keys in this package. No NEXT_PUBLIC secret, migration credential or signing private key. Runtime/migration/test and environment credentials remain separate. APP_ENV never authorizes an endpoint or substitutes for age/RBAC.

## Same-origin gateway (step 29)

`infra/gateway/Caddyfile` (Caddy, digest-pinned) is the only public entry point. Locally `pnpm infra:up` starts it on http://localhost:8080 (storefront origin) and http://localhost:8081 (admin origin), proxying to the dev servers on the host. The storefront origin forwards only `/api/v1/store/*` to Nest (as `/v1/store/*`). The admin origin forwards `/api/v1/auth/*` and `/api/v1/admin/*` (SSE unbuffered). Every other `/api/*` path returns 404, so internal and health routes are never public. Browser-supplied `X-Age-Verified`, `X-Forwarded-*`, `X-Real-IP`, `Forwarded`, `X-Request-Id` and all `X-IH-*` headers are stripped. The gateway sets `X-Request-Id` and `X-IH-Client-IP` itself. API bodies are limited to 64 KB. Nest keeps binding to a private address (`API_HOST=127.0.0.1` locally; the private network in containers). Production gateway (Caddy on the budget host or ALB on the replicated profile), TLS and Cloudflare origin protection are BI-06. The storefront origin also reserves `/api/age/*` for its own age-acceptance route handler (4 KB bodies). Media uploads never pass through the gateway: they use presigned POSTs to the private quarantine bucket. Request IDs are generated by the gateway (client-supplied IDs are dropped), passed to every upstream and returned to the browser. On Docker Desktop (macOS/Windows) the gateway reaches dev servers bound to 127.0.0.1. On Linux, run the dev servers on the docker bridge address or inside Compose instead; never expose Nest on a public interface. `pnpm test:gateway` verifies all of this against the real Caddy image (29 checks).

## Local infrastructure

Compose binds Postgres, queue Redis, MinIO and Mailpit host ports only to loopback. PostgreSQL 18 uses its version-specific Docker data layout and a new pg18-data volume; do not mount a PG17 volume into it or delete an old volume as an upgrade method. Use logical dump/restore or an approved major-upgrade procedure.

`infra/images.lock.json` records pinned references. Postgres/Redis/Node/Mailpit digests were fetched from the registry; MinIO/mc use digest-pinned Chainguard builds because official MinIO images are no longer publicly pullable; Docker runtime checks passed locally (see verification.md). All of these Compose credentials are local fixtures, never production credentials. Production storage is the selected approved UAE-region provider, not this dev MinIO instance.
