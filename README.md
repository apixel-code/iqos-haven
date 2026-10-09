# Iqos Haven — corrected development baseline

Dubai-only, 18+ guest commerce with Cash on Delivery and WhatsApp support. This archive contains the approved architecture, the 132-step implementation roadmap, design references, derived requirements, acceptance scenarios and a runnable foundation. It is not a completed commerce application.

## First run

Use Node 24 (`.nvmrc`), pnpm 10.28.0 and Docker Compose v2. If Corepack is unavailable, install the exact pnpm version separately.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm build
pnpm dev
```

Through the gateway (as browsers will use it): storefront http://localhost:8080 · admin http://localhost:8081. Direct dev servers: storefront http://localhost:3000 · admin http://localhost:3001 · API: http://localhost:4000/v1/health/ready · Mailpit: http://localhost:8025 · MinIO: http://localhost:9001.

The frontends currently show foundation pages. No public product routes, admin authentication, age ticket, checkout, order persistence or durable outbox exist yet. Health responses include dependency checks. Local Compose credentials are development examples only. Wait for services to become healthy and inspect `docker compose logs minio-init` before using object storage.

## Database workflow

Prisma + PostgreSQL 18, NestJS + Fastify. The Prisma schema intentionally has no business models; the 40 planned tables are specified in `docs/database-contract.md`.

```bash
pnpm db:generate                 # generate client; does not create SQL migrations
pnpm db:migration:create --name identity
# Review generated SQL, constraints and runtime grants before deployment.
pnpm db:migrate
```

`db:migration:create` requires a real schema change first. Empty/missing migration sets fail by default. For the current foundation only, `pnpm db:migrate -- --allow-empty` permits an explicit development-only no-op; it never permits an empty staging/production deployment. Migration credentials are separate from runtime credentials.

## Verification

```bash
pnpm build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:boundaries
pnpm test:infra
pnpm test:package
pnpm contracts:check
pnpm test:int                    # requires real local PostgreSQL and Redis
```

Integration tests require a dedicated `*_test` database and create/clean their own random schema. Never point them at runtime or production data. CI provisions PostgreSQL 18 and Redis; successful local unit checks do not prove production concurrency or recovery.

## Handoff

Start with `START-HERE-BN.md`, `docs/README.md`, `PROGRESS.md` and `docs/implementation-status.md`. The uploaded architecture is preserved verbatim in `docs/architecture.md`; derived documents do not override it. `docs/verification.md` records the checks actually run for this archive.

This ZIP excludes dependencies, build output, real environment files and Git history. Run `git init` if starting a new repository. Existing Claude commands and instructions remain available; no production deployment is configured until hosting and business inputs are decided.
