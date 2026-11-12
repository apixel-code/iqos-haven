# 0112 — Device colours as their own products, in model categories

- Status: Accepted
- Date: 2026-11-12
- Decided by: Marina (client request)

## Context

Each IQOS device model (ILUMA, ILUMA One, ILUMA Prime, ILUMA i, ILUMA i One, ILUMA i Prime) was one product, and its colours were variants with linked colour pictures (ADR 0107). The client wants devices to work like TEREA since ADR 0110: every colour is its own product with its own card, page, picture and stock. IQOS BONDS is not sold.

## Decision

This is a catalogue change, not a model change. It is made on production through the admin API by a one-off script (session scratchpad), following ADR 0110:

- **Categories:** one category per model, named like the model ("IQOS ILUMA Prime") with the old product's slug (`iqos-iluma-prime`). The existing "IQOS ILUMA" category (`iqos-iluma`) becomes the ILUMA model category.
- **Products:** one product per active colour, named "<Model> – <Colour>" (for example "IQOS ILUMA Prime – Jade Green") with slug `<model>-<colour>`. Each has one variant (no options) and carries over:
  - the price: the colour's override, else the model's price;
  - the compare-at price, only while it is above that price;
  - the "New" mark and the specifications;
  - the description, with one opening line naming the colour;
  - the colour's picture;
  - the low-stock alert.
- **Stock:** each colour's stock moves through the ledger: `INITIAL_STOCK` on the new product and `MANUAL` removed from the model's colour, both with notes and deterministic command IDs.
- **Old products:** the six model products are unpublished and moved into their model category, never deleted.
- **Old links:** the storefront permanently redirects `/p/<model>` to `/categories/<model>` (`next.config.ts`).
- **Home rows:** Offers and Featured entries that pointed at a model product point at its colour products.

## Consequences

- Device listings show 26 cards instead of six.
- Saved carts, wishlists and recently viewed items that point to a model's colours show as unavailable.
- Done on production 2026-11-12 after a dry run and a fresh encrypted backup (`ih-backup-20261112T071222Z`). New SKUs are `<SLUG>-01`, because the model colours keep their old SKUs. Model categories sort 1–6, before the TEREA countries. Featured and Offers swap each model for its first colour, so each keeps its size.
- The admin API allows 300 picture requests per hour per staff member, so the script waits and retries when it is rate-limited. The script can be re-run and skips finished steps.
