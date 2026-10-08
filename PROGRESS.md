# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M2 — shared reliability, communication and audit foundation (M0 review and M1 staging/fixtures still open)
- Step: 18 (audit storage + append-only writer) — done
- Branch: `step/18-audit-log` (baseline on `main`)
- See docs/verification.md for actual checks.

## Next action

Run `/step 19`: add `outbox_events` and `consumer_effects` (Prisma model + reviewed migration via `pnpm db:migration:create --name outbox`), event contracts with stable event IDs/schema version/required consumers and unique effect keys. Use `node@24` (`export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"`) and start Docker Desktop before `pnpm infra:up`.

## Blockers

None for steps 19–24. Step 25 (email) needs BI-07 for real providers (Mailpit is fine locally). Audit retention/pruning needs BI-08. All BI-01..BI-11 remain open; M0 needs client decisions; M1 staging needs BI-06.

## Gates passed

None. M0–M11 gates not claimed. M2 gate needs steps 19–24 (synthetic event processed by worker; duplicate delivery and Redis job-loss recovery demonstrated).

## Steps done

- Baseline — corrected foundation, Chainguard MinIO images, turbo concurrency — 5e11c40
- 18 — append-only `audit_log`, redacted domain diff, `AuditWriter` port, `PrismaAuditWriter` (unit-of-work only), write-only API `AuditService` — uncommitted (commit `step(18)` follows this handoff)

## Known deviations

- Local MinIO uses Chainguard rebuilds (`cgr.dev/chainguard/minio`, `minio-client:latest-dev`) pinned by digest because official MinIO images are no longer publicly pullable. Still MinIO; production storage provider is decided under BI-06. No ADR needed unless the provider changes.
- `audit_log` migration revokes UPDATE/DELETE/TRUNCATE only from a role named `ih_app`; other runtime role names must be revoked at provisioning (trigger blocks mutations regardless).

## Last session handoff (2026-10-08)

Done: environment set up (Node 24.21 via `brew install node@24`, added to `~/.zshrc`; Docker Desktop; `git init`; install; infra up); fixed MinIO image pull and `pnpm dev` concurrency; baseline commit on `main`. Step 18 implemented and reviewed by `invariant-reviewer` (no blockers; should-fixes applied: default PII redaction + `reveal`, oversize diffs truncate instead of failing the mutation, runtime-grant test, NUL/`__proto__` handling). Fixed `pnpm db:migrate` Prisma CLI resolution. Migration applied to local dev DB.

Files: `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261008151215_audit_log/`, `packages/db/src/{audit,audit.int.test,transaction,transaction.test,client,index,migrate}.ts`, `packages/db/package.json`, `packages/domain/src/{audit,audit.test,index}.ts`, `packages/application/src/{audit,index}.ts`, `apps/api/src/audit/*`, `apps/api/src/app.module.ts`, `apps/api/package.json`, `docker-compose.yml`, `infra/images.lock.json`, `turbo.json`, `docs/{verification,implementation-status,task-backlog}.md`.

Tests: `pnpm verify -- --integration` PASS (format, build, lint, typecheck, unit 55, boundaries, infra, package, contracts, integration 12).

Unfinished: audit read API (needs RBAC, step 27+), retention (BI-08). Machine note: `brew install node@24` upgraded `simdjson`, which broke Homebrew Node 25 (`node` formula); fixing it means `brew upgrade node` (→ 26) — awaiting Marina's decision.

## History (summary)

- 2026-10-08 (archive): corrected baseline — architecture integrated verbatim, derived specs, Prisma 7 + Fastify restored (ADR 0003), foundation defects fixed, prototype PII persistence removed. No gates claimed.
