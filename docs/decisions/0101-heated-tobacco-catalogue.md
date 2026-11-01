# 0101 — Heated-tobacco catalogue: IQOS devices and TEREA sticks

- Date: 2026-11-01
- Status: accepted (Marina); implementation in progress
- Step(s): post-launch-readiness change requested by the client, before the first real products

## Context

The store was specified and built as a vape shop.

- Product types are `disposable` and `kit`. The DB `CHECK` allows only those two, and publishing a `disposable` requires a puff count.
- Specs are vape fields: e-liquid ml, battery, coil, pod.
- The storefront has `/disposable-vapes` and `/vape-kits` pages, header links, home "Shop by category" tiles, puff filters and a compare table built on those fields.

Marina (2026-11-01): the client will sell **only two brands, IQOS and TEREA**. These are heated-tobacco devices (IQOS ILUMA i Prime / Standard / One in colours) and TEREA sticks (regional versions such as Japan, UAE, Swiss, Kazakhstan and Indonesia, each in several flavours). Reference listing: tereaabudhabi.ae (names only; its images and copy are not reused).

The vape labels would mislead shoppers: TEREA would appear under "Disposable Vapes", and puffs and coils mean nothing for these products.

## Decision

- **Two new product types, added (expand only, ADR 0100 / `pnpm test:migrations`):**
  - `device` — an IQOS device, sold in colour variants.
  - `sticks` — a TEREA version, sold in flavour variants.
  - The `CHECK` is widened to the four values. The existing `disposable`/`kit` rows and code stay valid, so a rollback to the previous release still works.
  - Retiring the vape types is a later `*_contract` migration, if ever needed.
- **Specs per type:**
  - `device`: compatible sticks, battery or sessions per charge, charging time, in the box, extra rows.
  - `sticks`: version or origin, sticks per pack, packs per unit (1 = pack, 10 = carton), flavour notes, extra rows.
  - No puff count is required for either type.
- **Admin:**
  - The product editor offers Device and Sticks, with fields per type.
  - Disposable and Kit remain readable but are no longer offered for new products.
- **Storefront:**
  - New pages `/devices` and `/sticks`.
  - The header links and the home "Shop by category" tiles become IQOS Devices, TEREA Sticks, New arrivals and Offers.
  - Filters and the compare table use the new specs.
  - `/disposable-vapes` and `/vape-kits` redirect permanently to the new pages.
  - Search keywords cover "iqos", "iluma", "device", "terea", "heets" and "sticks".
- **Copy:**
  - Vape wording in the storefront becomes heated-tobacco wording.
  - The 18+ gate and the "no product data before acceptance" rule are unchanged.
- **Prototype parity (ADR 0097):** layout, components and interactions stay as in the prototype. Only the category names, the specs fields and the copy change. This is a recorded, client-requested deviation.

## Consequences

- One migration, contract changes, admin and storefront updates, and tests. The change goes to staging first, then is promoted by digest.
- **Product images:** the client supplies them (supplier or own photos). Images are not copied from other sites (copyright).
- **Real product data:** prices, stock and pack or carton come from the client. Until then, products are entered as Drafts.
