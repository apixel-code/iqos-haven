# apps/api — NestJS with Fastify

- Layering: controller (HTTP, validation, guards) → application service (use case, transaction) → repository (SQL). Controllers contain no business rules.
- Validation: shared contracts from `packages/contracts`; unknown fields rejected; bounded strings/arrays/pagination.
- Guards on every non-public route: AuthGuard + PermissionGuard (+ AgeGuard for store catalogue/checkout). Serializers filter Owner-only fields for Staff.
- Mutations: one transaction via the shared transaction context; write audit + outbox/effects inside it; no network I/O inside it.
- Lock order: idempotency claim → existing order (if any) → mutated customer → settings/area → catalogue/price → coupon → variants; lock IDs in sorted order.
- Errors use the standard envelope with request ID. Never leak SQL, stack traces, or internal IDs that aren't part of the contract.
- Money in integer fils. Pricing logic only in `PricingService` / `packages/domain`.
- Routes: browser prefix `/api`, controllers under `/v1`. Nest is private behind the gateway.
- Every new endpoint: integration test for allowed role, denied role, and invalid input.
