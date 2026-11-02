# 0103 — TEREA taste profiles, taste filters and the client's catalogue blueprint

- Status: Accepted
- Date: 2026-11-02
- Decided by: Marina, from the client's blueprint (Google Doc "TEREA Abu Dhabi — Product Catalog & Architecture Blueprint")

## Context

The client sent a blueprint and asked for everything in it to be on the website, except product images (the client adds those later). The blueprint covers:

- regional TEREA editions
- a flavour matrix with body, intensity and cooling scores and click capsules
- ILUMA and ILUMA i hardware
- filters by cooling, capsule and origin
- delivery hubs and payment options
- trust and legal notes

Marina decided four questions (2026-11-02):

1. **New products:** use the lowest price of the blueprint's range, and publish them with stock 50.
2. **Payment:** cash on delivery only. No card on delivery, no payment links.
3. **Delivery time:** one delivery time for every area. No per-hub promises.
4. **Taste:** per-flavour taste ratings and filters.

## Decision

### Taste profiles (no migration)

- `sticksSpecsSchema.profiles` holds up to 50 entries, one per flavour. Each entry is `{flavour, body 1–5, intensity 1–5, cooling 0–5, capsule, notes?}`. It is stored in the product's `specs` JSON, so no migration is needed.
- Cooling bands for filtering, from the 0–5 score:
  - `none` = 0
  - `light` = 1–2
  - `strong` = 3–5
- Store search adds three filters, with facet counts. Each facet ignores its own filter, like the existing ones.
  - `origin`: sticks `specs.origin`, case-insensitive.
  - `cooling`: a product matches when any of its flavours is in a chosen band.
  - `capsule`: at least one capsule flavour.
- The `/sticks` and `/shop` filter panels show the groups TEREA version, Cooling and Capsule, each only when it has values, with removable chips.
- The product page shows a "Flavour profiles" grid for the flavours still offered. It has dot gauges and a click-capsule badge.
- The admin product editor gets one "Flavour profiles" textarea. Each line reads `flavour | body | intensity | cooling | capsule or - | notes`, like the existing "Label: value" extra specs.

### Trust and legal (from the blueprint)

- The footer and the terms carry an independent-retailer disclosure: not affiliated with, endorsed or sponsored by Philip Morris International. IQOS, ILUMA and TEREA are trademarks of their owners.
- The terms state that products are supplied factory-sealed.
- The nicotine warning was already on every product page.

### Catalogue data (entered through the admin API, audited)

Data comes from the blueprint, completed with edition and flavour availability from the reference listing tereaabudhabi.ae (names only).

- **New products**, published with stock 50:
  - IQOS ILUMA One, ILUMA (Standard) and ILUMA Prime, in a new category "IQOS ILUMA", at AED 150, 250 and 340.
  - TEREA Uzbekistan and TEREA Kyrgyzstan, at AED 120.
- **Existing editions** gain the blueprint flavours the reference listing offers for them.
- **Descriptions** carry the blueprint's edition and device text.
- **Every flavour** named in the blueprint's matrix gets its profile.

### Not taken from the blueprint

These parts stay out of scope, or were decided against:

- Card on delivery and payment links (Marina: cash only; online payment is out of scope at launch).
- 1–2 hour hub delivery promises and hub categories (Marina: one delivery time; per-emirate fees and hubs are out of scope).
- 24/7 automated WhatsApp Business ordering (out of scope).
- A 21+ age gate (the age stays 18, BI-04).
- Accessories, until the client lists products.
- "Grey-market" and comparative or competitor wording.

## Consequences

- No schema change. Profiles are validated by the contracts and by the store's specs parsing, and products without profiles simply show no taste section and no taste facets.
- The client edits profiles in the admin like any other specification.
- New-product prices are the low end of the blueprint's ranges and may need the client's review.
