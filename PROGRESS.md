# PROGRESS — Iqos Haven

## Current position

- Date: 2026-10-08
- Milestone: M0 specification review plus M1 corrected development baseline
- Status: uploaded architecture integrated verbatim; audit defects corrected; business modules remain pending
- See docs/verification.md for actual checks; previous archive claims are not current verification evidence.

## Next action

Review requirements/acceptance/design/database handoff against the supplied architecture. Resolve business inputs and screen states/assets. Finish M1 fixtures/components and staging after BI-06, then implement M2 audit/outbox/effect recovery.

## Blockers

All BI-01 through BI-11 remain open unless the client separately supplies evidence. Hosting/profile, accountant VAT/excise decision, preview/indexing policy, actual catalogue/SKUs, media/licensing, delivery rules and email setup cannot be invented by a code audit.

## Completed correction scope

- Approved architecture included; derived 19-area requirements, acceptance scenarios, 40-table contract, design/environment/security/runbooks and task tracker added.
- Prisma 7 + PostgreSQL 18 and NestJS Fastify restored (ADR 0003 supersedes original Drizzle choice).
- Foundation import rules, logger sanitization, DB/worker error handling, transaction retry bounds, migration fail-safe, isolated test harness and MinIO initializer corrected.
- API strict validation/error envelopes/request IDs implemented; only health endpoints are live.
- Environment/ports, pinned manifests/images, CI definition and setup instructions aligned.
- Prototype checkout/confirmation PII persistence removed; explicit COD collection and percentage-only coupon reference aligned.

## Gates

No M0–M11 milestone gate is claimed passed in this corrective handoff. M0 needs review/client decisions; M1 needs fixtures, staging and full component/shell coverage. M2–M11 business work is not implemented. A healthcheck job is not an outbox/effect consumer.

## Verification and operational caveats

See docs/verification.md. Real PostgreSQL/Redis integration, Docker image execution, full service boot, staging, load and restore drills must be run in an environment providing those dependencies. Restore RPO/RTO are targets, not observed performance.
