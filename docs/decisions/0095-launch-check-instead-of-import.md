# 0095 — Launch readiness check instead of import commands

- Date: 2026-10-18
- Status: accepted
- Step(s): roadmap step 124 (follows ADR 0036 and BI-10/BI-11)

## Context

Step 124 planned validated import commands for the real catalogue, settings and opening stock. Marina decided (2026-10-12, BI-10/BI-11) that the catalogue, settings and staff are entered through the admin, with no import. The first Owner still comes from `pnpm bootstrap:owner`. What remained of the step's done condition was the validation itself: real options, SKUs, images, an opening stock ledger, areas, fee and contact, and no demo seed.

## Decision

- **No import command.** The admin commands already validate every field, write `INITIAL_STOCK` through the ledger, and audit each change.
- **`pnpm launch:check`** (`apps/api/src/cli/launch-check*.ts`; facts from `launchFacts` in `@ih/db`).
  - **How it runs:** reads the database in `DATABASE_URL` with one connection and changes nothing. It prints PASS / WARN / FAIL lines and exits 1 if any item blocks (2 if it cannot read).
  - **Blocking:**
    - migrations not applied (compared with the build's `prisma/migrations`) or unfinished;
    - no active Owner;
    - staff on reserved test domains;
    - store name or domain missing or reserved; no contact; no WhatsApp number;
    - no delivery fee, promise or active area;
    - nothing published, or a published product without an active option or an image;
    - stock that differs from the sum of its ledger movements;
    - prototype demo coupon codes;
    - fixture slugs (`gatecheck`, `qa`, `test`, `synthetic`, `fixture`).
  - **Warnings:** sold-out published products, new-order email off, SEO indexing closed, dead effects. Also a migration history the role cannot read; run as the migration role for that line.
  - **Privacy:** counts and setting names only, never emails or names.
- **The bootstrap runbook** (`docs/runbooks/owner-and-data-bootstrap.md`) now gives the launch sequence:
  1. migrate;
  2. Apixel bootstrap Owner;
  3. invite the client Owner, then deactivate the Apixel account;
  4. settings;
  5. catalogue and opening stock;
  6. `launch:check`;
  7. open checkout.

## Consequences

- Launch readiness is one repeatable command, usable on staging and production, rather than a manual checklist.
- The fixture-slug rule could flag a real product whose slug starts with one of those words; rename the slug, or treat it as a known exception in the launch record.
- Environment and provider checks (keys, origins, email sender) stay with each app's startup validation and the deploy runbook.
