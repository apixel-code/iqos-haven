# Iqos Haven — Claude Code project memory

Dubai-only, 18+ age-gated vape e-commerce. Guest checkout, Cash on Delivery, WhatsApp support.
Client: Iqos Haven (iqoshaven.com). Built by Apixel.

## Session start

A SessionStart hook prints the top of `PROGRESS.md`. Trust it for current step; run `/start` for full context.
Commands: `/start`, `/step N`, `/verify`, `/handoff`, `/adr <title>`.

## Read order (do NOT bulk-load docs)

1. This file (auto-loaded) + hook output.
2. `PROGRESS.md` only if the hook output is not enough.
3. Roadmap: only the current step row + its milestone gate → `rg -n "^| <N> " docs/roadmap.md`.
4. `docs/architecture.md` — grep the heading you need, read that range only. Never whole.
5. Prototypes (`docs/prototypes/storefront.html` 330 KB, `admin.html` 540 KB) — NEVER `Read` whole.
   Look up the symbol in `docs/prototype-map.md`, `rg -n` it, read ≤150 lines. For a wide visual/UX question, delegate to the `prototype-reader` subagent.

Source of truth: architecture.md (Rev 2) > roadmap.md > acceptance.md > prototypes.
Prototypes define look, copy, interaction only. Their demo logic is NOT a requirement.

## Stack (versions: ADR 0001)

- Node 24, pnpm 10 + Turborepo 2, TypeScript 6.0 strict, ESLint 9 flat config. Don't bump TS to 7 or ESLint to 10 (see ADR 0001).
- `apps/storefront` (:3000) — Next.js 16 App Router + Tailwind 4. Age-gate signer + metadata handlers only; no commerce logic.
- `apps/admin` (:3001) — Next.js 16 on shared tokens (`@ih/tokens`, `@ih/ui-core`).
- `apps/api` (:4000) — NestJS 12 with Fastify, nestjs-pino. Routes `/v1/...` (URI versioning); gateway maps browser `/api`.
- `apps/worker` — BullMQ 6 + ioredis; refuses non-`noeviction` Redis outside development/test; 20 s shutdown deadline.
- `packages/*` (scope `@ih/`): config, logger, contracts, domain, application, db, platform (storage + service auth), tokens, ui-core. Compiled to CJS `dist/` — run `pnpm build` (or `pnpm dev`) after changing a package.
- Dependency direction enforced by ESLint: domain/contracts ← application ← db ← apps. Packages never import apps.
- DB: Prisma 7 + pg adapter (ADR 0003 supersedes 0002). `withTransaction()` (READ COMMITTED), `DbExecutor`, `sortedForLocking()` in `@ih/db`.
- Env: every app validates with a schema in `@ih/config`. New variable → add to schema + `.env.example`.
- Local infra (Docker Compose): PostgreSQL 18 (`ih_owner` migrations / `ih_app` runtime / `iqos_haven_test`), queue Redis, MinIO (3 private buckets), Mailpit.
- Each app/package has its own `CLAUDE.md` with local rules (loaded only when you work there).

## Commands

```
pnpm install
pnpm infra:up                 # docker compose up -d
pnpm build                    # packages must be built before apps run
pnpm dev | pnpm --filter @ih/<app> dev
pnpm lint && pnpm typecheck
pnpm test                     # unit (no infra needed)
pnpm test:int                 # *.int.test.ts against real PostgreSQL/Redis
pnpm db:generate              # Prisma client only
pnpm db:migration:create       # reviewed Prisma SQL migration
pnpm db:migrate
pnpm format
```

Keep in sync with root package.json. If a script is missing, add it — don't guess variants.
Tests: `*.test.ts` = unit, `*.int.test.ts` = integration (separate vitest config).

## Non-negotiable invariants

- Money = integer fils (AED × 100). No floats, no client prices. Half-up rounding; allocation per accountant-approved examples.
- Server quote is authoritative; changed price/config needs explicit re-acceptance.
- Order creation = ONE transaction: stock, coupon, order, snapshots, history, outbox/effects. No network calls inside a DB transaction.
- Idempotency key per checkout attempt: same payload → same order; changed payload → conflict.
- Lock order: idempotency claim → existing order (if any) → mutated customer → settings/area → catalogue/price → coupon → variants (deterministic, sorted IDs).
- Stock changes only through `stock_movements`. Zero stock does NOT unpublish.
- Order states: Pending → Confirmed → Processing → Out for Delivery → Delivered | Cancelled. Delivered ≠ collected; collection is an explicit command.
- Orders never deleted. Cancel needs reason + command ID; stock released exactly once.
- Age gate server-side (Ed25519 HttpOnly ticket, private signing key only in storefront acceptance handler + API `AgeGuard`). Unverified = zero product data (name, image, price, JSON-LD). No UA bypass.
- RBAC in API (guards + field filtering), not only hidden UI. Last Owner cannot be removed.
- Audit + outbox written atomically with the mutation.
- Structured redacted logs. No PII, tokens, cookies, raw SQL, stack traces to clients.
- Checkout PII is memory-only on the client. Never localStorage/sessionStorage.

## Prototype traps (do NOT copy)

- Legacy prototype checkout persistence has been removed; keep production PII memory-only and clear old `co`/`lastOrder` keys.
- Age in sessionStorage → server-signed cookie.
- Demo coupons SAVE20 (fixed) / VEKTOR15 (brand-scoped) → percentage only, one code, no stacking.
- Free-delivery progress bar → hidden while free threshold disabled (default off).
- Admin `setStatus` showing Delivered as "Collected" → collection is separate.
- `rng()`/`Math.random` demo data, `mkOrder`/`simulateOrder`, fake charts, demo reviews, hard deletes, `loginAs`/dev toggles, guided `flowRun` tour.

## Out of scope at launch

Customer accounts, online payments, WhatsApp Business API, custom-role builder, MFA, fixed/brand-scoped coupons, multi-emirate delivery, external search, cross-device confirmation. Product indexing off unless approved.

## Working a step

1. Confirm step N + "done" condition. If `docs/business-inputs.md` marks a blocker for it, stop and say so.
2. Order: migration → contract → domain/application → repository/transaction → controller/guard → UI → tests.
3. Test what matters: money, concurrency, security, idempotency, recovery. No mirrored tests for trivial UI.
4. `/verify` before claiming done.
5. `/handoff`, then commit `step(N): <summary>` on branch `step/N-short-name`; merge to `main` via PR once CI is green. One step per commit.

## Token & context hygiene

- Prefer one roadmap step per session; user-authorized wider fixes may span multiple steps. `/handoff` → `/clear` between steps.
- Before `/compact`, run `/handoff` so nothing lives only in chat.
- Wide searches → Explore subagent. Prototype questions → `prototype-reader`. Invariant review → `invariant-reviewer`.
- `rg -n` + ranged `Read`. Never read lockfiles, `dist/`, `.next/`, `.turbo/`, `coverage/`, generated clients.
- Don't echo whole files back after editing. Don't paste big logs; tail/grep them.
- Durable decisions → `docs/decisions/NNNN-*.md` (`/adr`), not chat.

## Communication

Marina: Bengali-English mix in chat, direct and decisive. Code, comments, commits, docs in English.
