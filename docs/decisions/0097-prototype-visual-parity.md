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

## V-S4 (product page), 2026-10-18

- **Layout:** the prototype's `pdp` grid (one column, two from 820 px), the gallery sticky beside the buy box, then `pdp-more` (About this product, the `specs` table), Reviews and "More like this".
- **Gallery (G-S12):**
  - The prototype's scroll-snap `gal-track`: phones swipe, with the dots; from 720 px thumbnails, which scroll the track.
  - The prototype's "Demo render" pill becomes a real **Zoom** button. It opens a modal `<dialog>` with the large derivative. There a click toggles 2× at the pointer (the keyboard zooms the centre), the arrow keys and buttons step through the images, Escape or the backdrop closes it, and the gallery stays on the last image viewed. Pinch zoom is the browser's own (`touch-action: pinch-zoom`).
  - The prototype has no zoom, so this view is new design on the prototype's tokens.
- **Buy box:**
  - Brand link, `h1`, `rate-link`, the 26 px price with the struck-through price and the "Save N%" badge, and the `stock` dot.
  - Options stay radio inputs (keyboard, the existing passes) drawn as the prototype's `flv` chips. Nicotine or strength uses the `seg` control. There are no swatches: options carry no colour value.
  - `buy-row`: the stepper, the primary button and the big heart (`wishbig`).
  - After an add the button says "Added" for 1.5 s. The prototype's fake 260 ms delay is not copied. On every width the cart sheet still opens (ADR 0083).
  - Then the `wa-link`, the kit compare checkbox with "(N selected · view)", the `assure` box and the nicotine `warn`.
- **Copy changed from the prototype's placeholders:**
  - The delivery row reads "Delivery across the UAE / All seven emirates, one flat delivery fee shown at checkout." (BI-03). The prototype's "Dubai, same-day, AED 15, free over AED 150" is not carried over.
  - "Genuine brand stock / Sourced from authorised UAE distributors." is kept as written in the prototype. The client confirms it with the rest of the launch copy.
- **Specifications:** the prototype's rows. Disposables also show "Nicotine" and "Flavours" when those options exist.
- **Reviews:** the prototype's `rv-sum`, `rv-bars` and `rv` markup on the real data (step 95). The demo badge, demo weights and demo reviews are not copied.
- **More like this:** the brand's other products, then the same type from other brands, never sold out, at most four (`relatedProducts`, unit-tested), in the prototype's `rail` under `secHead`.
- **Sticky bar:** it uses the prototype's `satc` markup. It now shows as soon as the main button is above the viewport. The check runs on scroll instead of in an IntersectionObserver: with images above it the button starts below the fold, and a jump (the reviews link, a restored scroll) passed it without an intersection change, so the bar never appeared.

## V-S5 (cart, checkout and confirmation), 2026-10-18

- **Cart:** the prototype's `cart-page` grid. On the left are the `line` rows (picture, name, brand and options, small stepper, price, Remove) and the `wa-card`. On the right is the sticky `panel` with the subtotal, the area and code (`field`, `promo-f`, `promo-ok` once a code applies), `totals` and the Checkout button. The heading counts the items.
- **Empty cart (G-S14):** the prototype's `emptyCart`. It shows the products this device viewed recently or, with no history, the Owner's published best sellers (read with the home content on the server). Sold-out products are never shown, and nothing appears when neither list has any.
- **Checkout:**
  - The prototype's `co` grid, numbered `co-step` sections, `field`/`input`/`prefix`/`errmsg`/`help`, the address-type `atype` with icons, the `errsum` summary, `pay-opt` and the `check` box.
  - The steps stay as built (ADR 0041). Area and code keep their own block, step 3 "Delivery area and total", because the code has its own form and the accepted total belongs beside them. So there are four steps, not the prototype's three. The prototype's "Card, Apple Pay, Tabby" placeholder row is not shown (online payments are out of scope).
  - The step sections have no `aria-labelledby`: "Delivery area and total" would also name the area field's section.
- **Folded summary on phones (G-S8):** under 900 px a `details.sumdet` titled "Order summary · <amount>" replaces the side panel. The amount is the accepted total once there is one, until then the subtotal (said to screen readers). Opening it shows the `mini-line` rows, the subtotal and "Edit cart". From 900 px the same content sits in the sticky side panel. The summary has no "Total" row of its own, so the authoritative total appears once, in step 3.
- **Confirmation:** the prototype's `done`, with the `done-ic`, `cashbox`, `steps` timeline, items and `totals`, the address, and the actions (`btn-primary`, `btn-wa`). The page has no first-name greeting: the confirmation snapshot carries no customer name (step 81).
- **Fixed on the way:** a product with no images put an `aria-label` on a plain div (axe `aria-prohibited-attr`). The empty gallery no longer has one.

## V-S6a (sheets, toasts and the compare tray), 2026-10-18

V-S6 is split in two PRs: V-S6a (this section) and V-S6b, which covers the saved, compare, help and brands pages and the gate.

- **One sheet for all:** the cart, menu, search and quick-add sheets now use the shared `Sheet`: the prototype's backdrop and panel on a modal `<dialog>`. Each keeps focus, closes on Escape or the backdrop, and gives focus back after sliding out.
  - The Sheet takes the prototype's sides: `right` for the cart on phones, a `pop` under the header's cart button from 720 px, `left` for the menu, `top` for search, and `bottom` for quick add (centred from 720 px).
  - It accepts a custom head (the menu's wordmark, none in search).
  - Reopened while still sliding out (an add right after closing), it slides back in instead of staying open but hidden.
- **Sheet contents:**
  - **Cart:** the prototype's `cartSheet` lines and foot. No payable total stays in the sheet (ADR 0082).
  - **Menu:** search, `mnav` rows with counts, and the `macc` accordions for Brands and Help. These are buttons with `aria-expanded`, and a closed panel is `inert`.
  - **Search:** `sq-box`, `sq-sec`, chips, `sq-item` rows with the typed text marked, and `sq-all`. The search body stays mounted after the first open: unmounting it on submit took the GET form out of the page before the browser sent it.
  - **Quick add:** `q-thumb`, brand and name, then the shared buy box.
- **Toasts (G-S10):** the prototype's `toast`. One message at a time; it disappears after 3.2 s, or 6 s with an action, and a pointer or focus holds it. It is announced in a polite live region.
  - A modal sheet sits in the browser's top layer, so each open sheet has its own toast host and only the topmost host shows the toast. A toast raised in the cart sheet appears over it, and its Undo can be clicked.
  - **Messages:**
    - "Removed from cart" with **Undo**: `restoreCartLine` puts the stored line back in its place, unless the variant is back in the cart or the cart is full.
    - "Saved on this device · No account needed" with **View saved**, and "Removed from saved items".
    - The saved and compare limits.
  - Adding to the cart still opens the cart sheet on every width (ADR 0083), so there is no add toast.
- **Count bump (G-S10):** the cart count bumps when it changes (`CountBadge`), but not for the count read from storage on load. Reduced motion turns it off.
- **Compare tray (G-S11):** the prototype's `ctray` with the kits' thumbnails, "N of 3 kits", Compare, and "Clear compare". It is hidden on the compare, checkout, product and confirmation pages, and while it shows the WhatsApp button moves up (`wafab up`).
- **Not built:** the prototype's WhatsApp sheet with a message preview. WhatsApp links still open WhatsApp directly with the prepared message.

## V-S6b (saved, compare, help, brands and the gate), 2026-10-18

With V-S6b the storefront part of the parity programme is done: every shopper page uses the prototype's markup.

- **Saved items:** the prototype's `wishlist`. The page head notes "Saved on this device" with the phone icon (a new `leadIcon` option on `PageHead`). An empty list shows the `.empty` state with the heart. Products the store no longer offers are listed in a `notice` with a way to remove them.
- **Compare:**
  - The prototype's `comparePage`: a `cmp-wrap`/`cmp` table with a picture, brand, link and Remove per kit, the best value in a row marked `best`, and a last row of "Add to cart" buttons (quick add) or a "Sold out" badge.
  - Fewer than two kits shows the `.empty` state with the prototype's copy.
  - With fewer than three kits, "Add a kit" lists up to four other kits from the API, each with "Add to compare". The section is optional and left out if the API can't be read.
- **Help:**
  - The prototype's `help`, as one page: the topic `tabs` are chips that jump to Delivery, FAQ and Contact or open a policy page. The menu's `/help#help-*` links keep working.
  - The sections use `prose` markup and the questions the `faq` markup.
  - The delivery facts still come from the Owner's settings (fee, time, emirates served). The prototype's Dubai-only placeholders are not copied.
  - Contact has the prototype's "WhatsApp <number>" button and "Copy number" (`CopyButton`, which confirms with a "Copied" toast).
- **Brands:** the prototype's brand tiles (`BrandTile`, now shared with the home page), shown on the brands page as a grid of 2, 3 or 4 columns, then the two type tiles (`cats`).
- **Brand page:** the prototype's `bhero` header with the logo, name, description and product count. The prototype's "from" price is left out: the brand read carries no lowest price.
- **Age gate:**
  - The prototype's `gateShell`: the arcs, the wordmark with the adults-only badge, the `gate-card` with the `18+` seal (a lock on the restricted page), the `gate-actions` pair and the fine print.
  - The foot keeps the address and policy links. The prototype's trade-licence placeholder waits for client copy.
  - The answers are still the two plain form posts, so they work without JavaScript, and the gate renders no catalogue data. `pnpm test:age-preview` and `pnpm test:gate` both pass.

## V-A1 (admin shell, overlays and confirmations), 2026-10-18

The admin parity work starts here. It follows the storefront's method: the prototype's styles, its markup and its icon sprite, on real data.

- **Styles:**
  - `apps/admin/app/prototype.css` holds the admin prototype's `<style>` block, copied verbatim into the `components` layer, with `@container` changed to `@media`. The existing admin rules in `globals.css` still win where a screen has not been rebuilt yet.
  - Left out: the tokens (`@ih/tokens/admin.theme.css` holds them), the prototype chrome, the coach and guide tours, the `body` rule (the sign-in pages keep theirs) and the global hidden scrollbars (admin tables need a visible scrollbar on a desktop).
  - The duplicate unlayered `button, input { font: inherit }` in `globals.css` was removed. Tailwind's preflight already sets it, and the unlayered copy overrode every prototype font size.
- **Icons:** the prototype's 79-symbol sprite is in `components/icons.tsx`.
- **Shell (G-A12):**
  - **Sidebar:** the prototype's `navHtml`: groups (Commerce, Storefront, Insights, Administration), icons and sub-items (Categories and Brands under Products). It becomes an icon rail from 720 px and the full 244 px sidebar from 1100 px.
  - **Counts:** pending orders, low or sold-out stock (`warn`) and reviews waiting. They come from the dashboard read, which leaves out what the user may not see, and are read every minute and on each page change.
  - **What a user sees:** entries the user's rights don't cover are left out (`visibleNav`); the API still decides every request.
  - **Placement:** Delivery sits with Settings. Notifications are reached from the bell.
- **Topbar and account:**
  - **Topbar:** global search, the role pill, the bell and, on a phone, the account button.
  - **Account menu:** name, email and role; light, dark or match-device theme (kept in this browser only); and Sign out, which still passes the unsaved-changes guard.
- **Global search:** looks up orders, products and customers on the server (`?q=`, the API checks each list), after a short pause, for 2 characters or more. `/` focuses the field, as in the prototype. On a phone it is the prototype's search modal. Nothing typed is kept.
- **Page head:** the prototype's `pageHead`, with its fixed subtitles. The home page has the greeting ("Good evening, …") and the Dubai date and time. The subtitles the prototype counts in the title wait for each screen's PR.
- **Phone:** the bottom bar (Home, Orders, Stock, Products and More). More opens the full menu as the prototype's drawer, with the account and Sign out.
- **Overlays (G-A13):**
  - The prototype's `modal`, `drawer` and `toast` are built on a modal `<dialog>`. Focus stays inside, Escape closes, and focus goes back to the opener; the prototype has none of these. A layer can mark the control to focus first (`data-autofocus`).
  - **Toasts:** up to three, 3.8 s or 6.5 s with an action, and held while pointed at or focused. Errors are announced assertively. As in the storefront, each open layer has its own toast host.
  - **The bell:** the prototype's `#bell` and `.notif` panel. Each notification is one button: it is marked read and opens what it links to. The icon follows the link (order, stock, review).
- **Confirmations (G-A13):**
  - All 21 `window.confirm` calls, the one `window.alert` and the unsaved-changes guard's own dialog now use `confirmDialog()`: the prototype's `confirmDlg`, with a title, optional body, a named button and red for destructive actions.
  - A destructive question starts on Cancel ("Keep editing"); any other starts on the answer.
  - The browser passes answer it through `scripts/browser-qa/confirm.mjs` (`autoConfirm`, `answerConfirm`).

## Consequences

- The look comes from the approved source instead of being re-imagined in utilities, so later screens are mostly markup work.
- Pages carried over lose their Tailwind classes; mixed pages keep working because the prototype rules are layered below the utilities.
- Media queries include the scrollbar width on desktop browsers with classic scrollbars, so breakpoints can trigger up to about 15 px earlier than in the prototype frame.
- Browser and age-preview checks match prices as `AED </span></span>49` or ignore whitespace, because the sign is drawn and "AED" is hidden text.
