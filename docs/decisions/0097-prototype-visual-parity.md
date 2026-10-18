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

## Consequences

- The look comes from the approved source instead of being re-imagined in utilities, so later screens are mostly markup work.
- Pages carried over lose their Tailwind classes; mixed pages keep working because the prototype rules are layered below the utilities.
- Media queries include the scrollbar width on desktop browsers with classic scrollbars, so breakpoints can trigger up to about 15 px earlier than in the prototype frame.
- Browser and age-preview checks match prices as `AED </span></span>49` or ignore whitespace, because the sign is drawn and "AED" is hidden text.
