# 0001 — Stack and runtime versions

- Date: 2026-10-07
- Status: accepted
- Step(s): 6, 7, 8

## Context

Architecture Rev 2 fixes the shape (pnpm/Turborepo monorepo, Next.js front ends, NestJS API, BullMQ worker). Exact versions had to be chosen at bootstrap.

## Decision

- **Node 24 LTS** (`.nvmrc`, engines `>=24.15.0 <25`). NestJS 12 tooling requires Node ≥ 22.22.3; 24 LTS gives the longest support window.
- **pnpm 10** + **Turborepo 2**. Internal packages compile to CommonJS `dist/` with `tsc`; apps consume built output (`^build` dependency in turbo).
- **TypeScript 6.0** (not 7). typescript-eslint supports `<6.1`; revisit when it supports TS 7.
- **ESLint 9** flat config (not 10). `eslint-config-next` plugins (import, react, jsx-a11y) don't declare ESLint 10 support yet. ESLint 9 is end-of-life upstream: upgrade as soon as those plugins support 10.
- **Next.js 16** (App Router) for **both** storefront and admin, React 19, Tailwind CSS 4 (`@theme` mappings in `@ih/tokens`).
- **NestJS 12** with **Fastify 5** + `nestjs-pino`; Vitest + `unplugin-swc` for decorator metadata in tests.
- **BullMQ 6** + `ioredis 6` on a dedicated queue Redis with `noeviction`.
- **Fonts self-hosted** via `@fontsource` (Poppins, JetBrains Mono): no Google Fonts request from an age-gated store, and builds work offline.

## Alternatives considered

- Vite SPA for admin — rejected: one framework for both front ends, shared tokens/components, same-origin gateway story.
- `next/font/google` — rejected: third-party request at build time; self-hosting is simpler and private.

## Consequences

- When typescript-eslint supports TS 7, or eslint-config-next supports ESLint 10, upgrade in a dedicated commit.

- Corrected database/runtime: Prisma 7 + pg adapter, PostgreSQL 18. Exact installed versions are pinned in manifests and pnpm-lock.yaml. ESLint 9 compatibility debt remains explicit; upgrade in a separate verified change.
