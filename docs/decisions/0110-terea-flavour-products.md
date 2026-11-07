# 0110 — TEREA flavours as their own products, in country categories

- Status: Accepted
- Date: 2026-11-08
- Decided by: Marina (client request)

## Context

Since ADR 0101, each TEREA product was one regional edition, such as "TEREA Uzbekistan", and its flavours were variants. One listing card stood for the whole edition, and its flavours were chosen on the product page (with flavour pictures since ADR 0107). The client wants every flavour to be its own product, with its own card, page, picture, price and stock. The TEREA categories should be countries.

## Decision

This is a catalogue change, not a model change. The catalogue already supports products without options, any number of categories and one flavour profile per product. It was made on production through the admin API by a one-off script (session scratchpad). The script validated and audited each step like staff work:

- **Categories:** seven country categories, "TEREA <Country>" with slug `terea-<country>`: Uzbekistan, Kyrgyzstan, Kazakhstan, Indonesia, Japan, Swiss and UAE. Sort order is 10 to 70, after the device categories. The old "TEREA sticks" category is in the trash.
- **Products:** one product per active flavour, named "TEREA <Flavour> – <Country>" with slug `terea-<flavour>-<country>`. Each has one variant (no options) and carries over:
  - the price: the flavour's override, else the edition's price;
  - the compare-at price, only while it is above that price;
  - the "New" mark;
  - the description, with one opening line naming the flavour and edition;
  - that flavour's profile and notes;
  - the flavour's pack picture (its linked gallery picture);
  - the low-stock alert.
- **Stock:** each flavour's stock moved through the ledger. `INITIAL_STOCK` was added on the new product and `MANUAL` removed on the edition's flavour, both with notes and deterministic command IDs.
- **Without a picture:** a product cannot be published without one, so the flavours that had no pack picture stay as drafts until one is added (Indonesia: Black Green, Apricity, Yugen; Japan: Smooth Regular, Menthol, Fusion Menthol, Rich Regular).
- **Editions:** the seven edition products are unpublished and moved into their country category, never deleted, because past orders refer to them.
- **Old links:** the storefront permanently redirects `/p/terea-<country>` to `/category/terea-<country>` (`next.config.ts`).
- **Offers:** the home Offers section now lists flavour products. The `/offers` page lists every product with a compare-at price on its own.

## Consequences

- TEREA listings show about forty cards instead of seven. Country filtering is now the category, and the existing origin facet still works.
- A shopper's saved cart, wishlist or recently viewed items that point to an edition's variants show as unavailable. This is acceptable one week after launch.
- Flavour pictures (ADR 0107) stay useful for devices with colours. TEREA products now have one picture each.
- Staging holds no catalogue data, so the change was checked with a dry run on production and a fresh encrypted backup taken right before it (`ih-backup-20261107T192956Z`). The script can be re-run and skips finished steps.
