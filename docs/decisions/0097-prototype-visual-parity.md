# 0097 — The UI matches the prototypes: approach and plan

- Date: 2026-10-18
- Status: accepted
- Step(s): visual parity programme, before launch (follows ADR 0084 and the step 115 parity review)

## Context

Step 115 and the nine launch gaps compared features. A side-by-side screenshot audit of the prototypes and the built apps (2026-10-18) showed:

- **storefront:** moderately different (header, hero, category tiles, filters, cards, footer, overlays);
- **admin:** very different (icon sidebar with counts, global search, page heads with actions, tabbed tables with tags and row menus, drawers, toasts, phone bottom nav).

**Marina's decisions (2026-10-18):**

- the client needs the UI exactly as in the prototypes, storefront first, then the admin;
- prices use the new UAE dirham sign as the prototype draws it;
- every gap deferred earlier (O-tier, G-S8, G-A10) is built before launch.

## Decision

**Storefront approach (first PR, V-S1):**

- **CSS:** the prototype's own stylesheet is carried over as `apps/storefront/app/prototype.css`: base rules, motion and overlay hosts, and every store rule (prototype lines 113–195, 383–612, 651–5370).
  - `@container app (…)` becomes `@media (…)`: the prototype measures its device frame, the store the viewport. A real container would also capture `position: fixed` overlays.
  - The overlay hosts are fixed to the viewport.
  - Tokens stay in `@ih/tokens`, with the WCAG `--ink-3` (ADR 0084).
  - The rules sit in Tailwind's `components` layer, so pages not yet carried over keep their utilities.
  - Edits for the real site are marked `store:`.
- **Markup:** components emit the prototype's markup and class names. `Icon` / `IconSprite` carry its 42-icon sprite.
- **Prices:** `Money` / `Dirham` draw the dirham sign. "AED" is kept for screen readers and copy-paste, and in plain text (emails, CSV, aria-labels).

**Storefront order (one PR each):**

1. **V-S1** shell: promotional bar, header (wordmark, sections with the Brands panel, search bar or button, WhatsApp, saved and cart icons with counts), footer (brands, help, legal, follow-us links from the Owner's Contact settings), phone bottom navigation, WhatsApp button, dirham sign.
2. **V-S2** home: hero carousel, trust strip, category tiles, sections, "by puff count" (G-S13).
3. **V-S3** listing and search: prototype filters and sort, chips, mobile filter sheet with "Show N" (G-S6), cards, skeletons (G-S7), no-results WhatsApp (G-S9).
4. **V-S4** product page: gallery swipe and zoom (G-S12), buy box, reviews.
5. **V-S5** cart, checkout and confirmation: collapsed mobile summary (G-S8), empty-cart best sellers (G-S14).
6. **V-S6** sheets, saved, compare, help, brands and the gate: prototype sheets, toasts and count bump (G-S10), compare tray (G-S11).

**Admin:** after the storefront.

- **V-A1** shell: icon sidebar with counts, global search, page heads, bottom nav and "More" sheet (G-A12); toasts, drawers and a confirm dialog instead of `window.confirm` (G-A13).
- Then one PR per screen group, including G-A10 and G-A14.

**Not copied (unchanged traps):**

- demo data and fake charts;
- checkout data in sessionStorage;
- coupon codes in the ticker (BI-13);
- "Dubai only" copy (BI-03; the footer says the UAE);
- placeholder legal lines (BI-01).

## V-S2 (home), 2026-10-18

**Marina's decisions:**

- The hero is the prototype's carousel of one to three slides.
- Campaign banners show no coupon code, so BI-13 still holds for codes.

**Hero content model:**

- Hero schema **v2** is `{ slides: [...] }`. Each slide has:
  - a `style` (`navy`, `lilac` or `coral`: the prototype's `s1`–`s3` looks);
  - an eyebrow, title and subtitle;
  - a button and an optional second button;
  - an image.
- `upgradeContent` reads a v1 hero (published before this change) as one navy slide. The store and the editor both use it, so nothing needs migrating.
- The store home answers `heroSlides`.

**Store home:**

- **Hero carousel:**
  - swipe, dots and arrows;
  - moves on every 5 s, pausing on hover or focus and with a pause button (WCAG 2.2.2);
  - never moves on its own with reduced motion;
  - one slide shows no controls;
  - until a hero is published, a default slide (UAE wording).
- **Trust line:** focusable on phones, where it scrolls sideways.
- **Category tiles:** four tiles with counts from the termless search facets, and a product photo where one exists.
- **Product sections:** "Popular right now" with the segmented toggle, the prototype card, and rails for the product rows.
- **Shop by brand:** brand logos (G-A7) when set.
- **Campaign banners:** without codes.
- **Puff counts:** "Disposables by puff count" (G-S13), linking to `/disposable-vapes` with `minPuffs`/`maxPuffs`. The storefront search now keeps `maxPuffs`.

**Admin:** the hero editor lists the slides. Each has a look, two buttons and an image, and can be added (up to three), moved or removed.

## V-S3 (listing and search), 2026-10-18

- **One shop view:** every listing (`/shop`, the type, brand, category and offers pages) and `/search` render `ListingPage` with the client `ShopLayout`, which is the prototype's `shop`:
  - breadcrumb chevrons and the shop heading;
  - filters beside the grid from 1040 px;
  - a toolbar with the count, the sort select and the Filters button;
  - removable chips with "Clear all";
  - the prototype's `.empty` state.
- **Filters:**
  - category checkboxes (one type narrows; both are every type);
  - brand checkboxes with counts;
  - the prototype's price bands (Under 50, 50–100, 100–200, 200+, without counts: the API has no price-band facet);
  - puff-count bands with counts summed from the puff facet;
  - nicotine checkboxes;
  - In stock and On sale switches.
  - Bands travel as `price=`/`puffs=` and are read into min/max bounds.
- **Instant apply:** a change applies at once, as in the prototype, by moving to the page's address without scrolling. The controls keep focus while the shopper changes them and reset when the address changes another way (chip, Back).
  - The grid shows the skeleton while the next page loads (G-S7).
  - Every form is still a plain GET form, with a `<noscript>` button.
- **Phone:** under 1040 px the Filters button (with its count) opens the prototype's bottom sheet, with "Clear all" and "Show N products" (G-S6).
  - The new shared `Sheet` puts the prototype's backdrop and panel on a modal `<dialog>`, which keeps focus, closes on Escape and gives focus back.
  - The other sheets move onto it in V-S6.
- **Search with no results:** offers "Ask us on WhatsApp" with a prepared message (G-S9).

## Consequences

- The look comes from the approved source instead of being re-imagined in utilities, so later screens are mostly markup work.
- Pages carried over lose their Tailwind classes; mixed pages keep working because the prototype rules are layered below the utilities.
- Media queries include the scrollbar width on desktop browsers with classic scrollbars, so breakpoints can trigger up to about 15 px earlier than in the prototype frame.
- Browser and age-preview checks match prices as `AED </span></span>49` or ignore whitespace, because the sign is drawn and "AED" is hidden text.
