# Implementation status — corrected baseline

## Implemented foundation

- pnpm/Turbo workspace with four buildable apps and eight shared packages; strict TypeScript and enforced import boundaries.
- Next.js storefront/admin foundation pages, self-hosted fonts, prototype tokens, Button and Spinner.
- NestJS Fastify API, private health routes, request IDs, strict Zod DTO validation and safe error envelopes.
- Validated environment modes, structured logger sanitization, PostgreSQL pool error handling, Prisma client generation and bounded Read Committed retries.
- Worker dependency startup bounds, Redis policy checks, worker error listeners, explicit supported health job and bounded shutdown.
- Versioned local infrastructure references, PostgreSQL 18 data layout, loopback-only development ports, separate DB roles, failure-propagating MinIO initializer.
- Unit/regression suites, isolated real-database harness, CI definition and generated implemented-health OpenAPI contract.
- Step 18: append-only `audit_log` (first business migration; trigger rejects UPDATE/DELETE/TRUNCATE, runtime role revoked), domain diff redaction (secrets never revealable, personal fields redacted by default, oversize diffs truncated), `AuditWriter` port, `PrismaAuditWriter` usable only inside `withTransaction()`, write-only API `AuditService` with no HTTP routes. Audit reads/retention wait for RBAC (step 27+) and BI-08.
- Step 19: `outbox_events` + `consumer_effects` with DB-enforced rules (immutable event identity/payload, unique (event, consumer) effect key, completion only after all required effects completed/skipped, skip needs reason, dead needs error and replays only to pending/retry with a counter, no lease on finished work, effects added only before completion, prune only completed). `@ih/contracts` event catalogue: 11 architecture events + `system.probe`, strict ID-only payloads, schema versions, required `consumers` (only implemented ones) vs documented `plannedConsumers`, `defineEvent()`, `effectJobId()`.
- Uploaded architecture, ordered roadmap, corrected prototypes, derived requirements/design/acceptance/database/security/operational references.

## Partial or awaiting review

Milestone 0 documentation exists, but business inputs, final screen states/assets, provider sizing and client approval are incomplete. Milestone 1 has runnable foundation code; staging deployment, fixtures, responsive shells, forms/dialogs/tables/error/loading components are incomplete. Seeded production roles, table-specific append-only privileges and startup/run smoke tests remain future implementation/release checks.

## Not implemented

The remaining 37 business tables; atomic outbox writer/effect relay/reconciler/scheduler; email/media adapters; bootstrap/auth/sessions/permissions/reset; gateway/CSRF/rate limits; catalogue/variants/inventory; Ed25519 age gate; private confirmation capabilities; tax/quote/coupons; transactional checkout/idempotency; operational orders/COD/returns; notifications/reviews/CMS/reports/SEO; production deployment, PITR and recovery drills.

No feature becomes complete because a document, exported primitive or demo screen exists. `packages/domain` money/order helpers are building blocks only. `packages/application` remains a use-case placeholder. Current frontend environment configuration does not imply that a gateway or API commerce integration has been implemented.

## Next implementation sequence

1. Review derived specifications, finish client inputs and design states/assets; close the Milestone 0 gate with evidence.
2. Finish the remaining Milestone 1 components/fixtures/staging after BI-06; keep real checkout unavailable.
3. Follow roadmap Milestones 2–11. Implement schema/contract/domain/use case/repository/controller/UI and relevant acceptance tests for each feature.
4. Treat all release and restore targets as unproven until measured against the chosen infrastructure.
