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

- 2026-10-25 (Marina approved): Next.js and `eslint-config-next` 16.4.0 → 16.4.3 in both apps, a patch upgrade. 16.0.0–16.4.0 carry two critical advisories, unauthenticated remote code execution (GHSA-2464-fhr4-w9xw: Image Optimization with SVG; GHSA-673q-mjm6-r5xr: `use cache` returning typed arrays), and a high one. `next build` also stops once on them. Other `pnpm audit --prod` findings (Fastify, zod, body-parser, multer, mysql2, deepmerge-ts, nodemailer, fast-uri) are left for a separate decision.

- 2026-10-25 (Marina approved): the other `pnpm audit --prod` findings, fixed as patch and minor upgrades within the pinned majors:
  - `fastify` 5.8.4 → 5.12.7, and NestJS (`common`, `core`, `platform-fastify`, `testing`) 12.1.2 → 12.2.0, which also brings Fastify 5.12.7.
  - `zod` 4.6.5 → 4.6.7 everywhere.
  - `nodemailer` 10.0.16 → 10.2.1.
  - Prisma (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) 7.10.0 → 7.10.1, which brings mysql2 3.24.4 and deepmerge-ts 8 to the CLI.
  - Transitive floors in `pnpm-workspace.yaml` `overrides`, each kept on its own major: `fast-uri` (3.x ≥ 3.1.9, 4.x ≥ 4.2.3), `multer` ≥ 2.5.0 and `body-parser` ≥ 2.4.0. The last two come only through `@nestjs/platform-express`, an optional NestJS peer the Fastify API never loads.

  Next.js is fixed separately (16.4.3). Remove an override once its parent package ships the fixed version itself.
