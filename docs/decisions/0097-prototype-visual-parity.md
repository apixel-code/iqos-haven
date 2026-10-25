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

## V-A2 (admin dashboard), 2026-10-19

- **Layout:** the prototype's `VIEWS.dashboard`, in order:
  1. The attention strip (`attn`) or "All caught up".
  2. Four `kpis` tiles.
  3. The quick actions (`qa`).
  4. Recent orders in a table from 720 px and as order rows (`mrow`) on a phone, beside Needs attention and Low stock (`split wide`, `list`).
  5. A `grid g2` row: the open orders' status bar (`sbar`/`sleg`), the best-selling products ranking (`rank`), and Booked sales for the Owner or "Your access" for Staff.
- **Data:** all of it comes from `GET /v1/admin/dashboard`, sections the API leaves out (`null`) are not drawn, and no figure is invented.
  - **The Owner's tiles** are the prototype's Revenue, Orders, Avg. order value and Pending, for today against yesterday from the daily tables. A day not computed yet says so instead of showing a change.
  - **Staff's tiles** are the prototype's operational set: today's orders, processing, out for delivery and pending.
- **Not carried over:**
  - The prototype's date-range picker and revenue chart: the dashboard read has today and yesterday only, and Analytics has the charts and ranges.
  - Best-selling brands: not in the dashboard read.
  - The recent-orders "Confirm" button: confirming needs the order's version and a command, so it stays in the order screen.
- **Quick actions:**
  - "Create order" and "Add product" open their forms through new `?new=1` links (`newOrderHref`, `newProductHref`); the orders and products screens read them.
  - Each action shows only for the rights it needs.
- **CSS (affects every admin screen):**
  - `globals.css`' element rules (`h1`, `a:hover`, …) and the old `.muted`, `.small` and `.eyebrow` now sit in `@layer base`, under the prototype's rules. Unlayered, they overrode the prototype's page heads and text sizes.
  - `prototype.css` sets the prototype's root `box-sizing: border-box` (from its first style block). Its `* { box-sizing: inherit }` otherwise fell back to content-box, and padded lists and nav items overflowed.
  - The old shell rules (`.workspace`, `.sidebar` …) and the old dashboard rules are gone. `.page-content` no longer adds a second padding inside the shell's `.page`. The analytics tiles keep their rules, scoped to `.kpi-grid`.

## V-A3a (admin orders list), 2026-10-19

The orders screens come in three PRs: V-A3a (the list), V-A3b (the order detail and its panels) and V-A3c (the manual order and the edit).

- **Page head:** the prototype's `VIEWS.orders` head with "N orders · M waiting for confirmation" from the counts read, and "Create order".
- **Toolbar:**
  - Status `tabs` with their counts.
  - A `toolbar` with search as you type (after a pause), the prototype's date choices, the sort, and "Delayed only" as a filter chip.
  - The date choices are All dates, Today, Last 7 days, Last 30 days and This month. They are Dubai days, from `orderRangeStart`, which is unit-tested; they replace the two free date-time fields.
- **Bulk confirm:** the prototype's dark `bulk` bar: "N selected", "Confirm N pending" and Clear. The confirm logic is unchanged (version per order, one command each, retry after an unclear answer).
- **Table:** the prototype's `tbl`, with a select box, the order number (and "Created in admin" for manual orders), customer, phone, amount with item count, COD and cash state, status badge (`st`), and placed time with the area.
- **Phone:** the prototype's order rows (`mrow`) replace the table, so the table no longer scrolls sideways (G-A12, for this screen).
- **Pages:** the prototype's table foot ("Showing 1–25 of N" and the pager). The list pages by position, so the pager steps back and forward rather than jumping to a page number.
- **Not carried over:** Export CSV and per-row action menus (Reports holds the exports; the actions are on the order).
- **Notices:** `ResourceNotice` has a `compact` form for rebuilt screens: a live region, plus a Reload button only when something failed.
- **Page heads:** screens that draw the prototype's page head themselves are listed in `WorkspaceSection` (`OWN_HEAD`), starting with orders.

## V-A3b (admin order detail), 2026-10-19

- **Layout:** the prototype's `VIEWS.order`:
  - **Top:** the back link, then a head with the order number, its status badge, "Placed … · via Storefront" and the actions (WhatsApp customer, Edit, Packing slip, Cancel).
  - **Progress card:** the five steps (`prog`), "Next: …" with the step's hint, and the advance button.
  - **`split` columns:** Items with the totals (`items`, `sum`), the return, the Timeline with the steps still to come (`tl`) and the edit history on the left. Customer, Delivery (`kv`), Payment with the cash records and the review link on the right.
  - **Phone:** an action bar (`savebar`) above the bottom navigation.
- **Drawers:** WhatsApp, Edit, Cancel and the cash record open in the prototype's drawers.
  - Their forms and logic are unchanged (versions, command IDs, retries, the separate cash collection).
  - The drawer carries the title, so the panel's own frame and heading step aside (`.in-drawer`).
  - After a save the drawer closes, the order reloads and a toast says what happened.
- **Kept as built:** the advance button stays one step at a time, and Delivered stays separate from cash collection ("Record COD collection", or the Owner's "Correct cash record").
- **Not carried over:**
  - The prototype's "Change status" menu: only the next step exists.
  - The customer's "previous orders" note and the Profile link: the order read carries no customer ID.
  - The prototype's in-line WhatsApp link: the WhatsApp drawer keeps the server-built templates.
- **Wording:** the edit is reached through "Edit". Tests that waited for an always-visible "Edit order" heading now open the drawer first.
- **Fixed:**
  - In dark mode, the WhatsApp green needs dark text (`--bg`).
  - a11y scans of a drawer wait for its slide-in: half-faded colours read as low contrast.

## V-A3c (admin manual order and order edit), 2026-10-19

- **Manual order:** the prototype's `VIEWS["order-new"]` wizard (`wizard`/`wz`):
  1. **Customer:** UAE mobile with "Find customer by phone", the returning-customer card with saved addresses ("Use this address" fills the Delivery step), and the name.
  2. **Products:** the picker and the lines with their quantities.
  3. **Delivery:** the area and address fields.
  4. **Review:** the summary, coupon, payment (COD), "Customer already confirmed" with how it was confirmed, and the 18+ check.

  Around the steps: an order summary beside them, and the `savebar` with the total, Back or Cancel, and Continue or "Create order · AED …".
  - A step's details are checked before going on.
  - Entering Review asks the server for the total.
  - The fields are kept in React state, so going back and forth loses nothing.
  - The quote, the idempotency key, the confirmation dialog and the request are unchanged, and the unsaved-changes guard covers the order through `useUnsavedChanges`.

- **Order edit:** stays in the drawer from the detail screen, with its form rebuilt in the prototype's fields (Items with quantities, the picker, coupon, the delivery address, the operational note). Its field names, and so `editCommand`, are unchanged.
- **Not carried over (traps, not rules here):**
  - The edit page's free status change, the Owner's manual discount percentage and the delivery-charge override.
  - The manual order's custom delivery charge: one flat fee (BI-03).
  - Online payment.
- **Fixed:**
  - On a phone the prototype hides the names of the steps that are not current; each step button keeps its name in `aria-label`.
  - A prototype label inside an older card keeps its layout (`.management-card label.label`).

## V-A4a (admin products list), 2026-10-22

- **List:** the prototype's `VIEWS.products`:
  - A page head with Categories, Brands and Add product.
  - Tabs All, Published, Drafts and Trash.
  - A toolbar with "Search name or SKU", which now searches as you type after a short pause. Category, brand, stock and sort use `fsel` selects, and a `chipf` chip clears each active filter.
  - The Trash note.
  - A `tbl` with the picture, the name with brand and type, category, price, stock, stock status, and visibility (or the time it went to Trash).
  - On a phone, `mrow` rows. Empty states with Clear filters / Add product.
  - The cursor pager, in the `tbl-f` foot.
- **Trash actions:** "Restore as draft", the "I understand this cannot be undone" check and "Delete permanently" (Owner) stay as they were, restyled as prototype buttons. Permanent delete still asks through `confirmDialog`.
- **Not carried over:**
  - Tab counts. The products API returns no counts per status, and counting on the client would show only the current page.
  - Its demo art tiles: a product without a picture shows a plain image tile.
- **Fixed:**
  - The older G-A8 list styles (`.product-row`, `.product-thumb`, `.stock-tag`) are removed; they overrode the table.
  - Both stock columns stay hidden without `inventory.read`, as before.

## V-A4b (admin product editor), 2026-10-22

- **Layout:** the prototype's `VIEWS.product`:
  - The back link and a page head with the product's link and status.
  - The section jump bar (`secnav`).
  - A `split` of cards:
    - Left column: Basic information, Images, Description & specifications, Options & variants, Search engine listing.
    - Right column: Publishing and Price.
  - The `savebar` with Cancel and Save draft / Save changes. On a phone it sits above the bottom navigation.
- **One form across the cards:** the product's own fields join one hidden `<form>` through the `form` attribute. The image, option and publishing cards between them keep their own forms and requests, and the field names and commands are unchanged. Each product card is its own unsaved-changes region with the same name.
- **Fields as in the prototype:**
  - `field`/`label` with `req` and `opt` markers.
  - Specifications in a two-column grid.
  - The description, meta title and meta description show the prototype's character counts. They are a guide; the server's limits stay.
  - The slug in an `/p/` affix.
  - The price and compare-at price in AED affixes.
- **Publishing card:** the prototype's look over the real readiness check: a Draft/Published tag, the missing requirements with an icon, and Publish, Move to draft and Move to trash as prototype buttons. The commands are unchanged.
- **Images and options:** placed in the prototype's cards. Their inner forms keep the older layout until V-A4c.
- **Not carried over:**
  - The prototype's Draft/Published radios and its Publish button in the save bar. Publishing stays a separate, checked command.
  - A product-wide stock quantity and alert. Stock is per option and changes only through the stock ledger; Inventory is linked instead.
  - A custom social-share image.
  - The "Google preview" name. Product pages are not indexed (BI-05), so the preview is labelled as a page title preview, with `/p/` URLs and "· Iqos Haven" titles as the store builds them.

## V-A4c (admin product images and variants), 2026-10-22

- **Images:** the prototype's `peMedia`:
  - A grid of square tiles (`media`/`mtile`) with the Primary badge, the drag grip, and controls for move left, make primary, alt text, move right and remove.
  - A drop zone (`drop`) that takes several files, chosen or dragged in. They are uploaded one after the other through the same signed, private flow.
  - Tiles reorder by drag and drop as well as with the arrows. Both send the same order command. `movedTo` is unit-tested.
  - Alt text is edited in the prototype's dialog from the tile. A tile without alt text says so.
  - Uploads still being processed, ready to add, or refused show as notes with "Add to gallery".
- **Primary image:** the "Primary" badge follows the image marked primary, not simply the first one. The order and the primary choice are separate, as the API has them.
- **Options & variants:** prototype fields for the option values, with "Save options" and "Add N missing combinations" or "Add single variant" beside them. Each variant is a compact block, its own form, in a bordered list:
  - Its name, Default, Inactive and stock tags.
  - SKU, a price override in an AED affix, and the low-stock alert.
  - Active, Make default and Save.

  The prototype marks variants as a future option; they exist here (steps 45–47), so they are drawn in its idiom. A table with editable cells did not fit the card at desktop width.

- **Not carried over:** "Add sample image" (demo only).

## V-A5 (admin inventory), 2026-10-22

- **List:** the prototype's `VIEWS.inventory`:
  - Page head.
  - Stock-state tabs (All, In stock, Low stock, Out of stock) with the prototype's coloured dots.
  - "Search product or SKU", searching as you type; Enter searches at once.
  - A `tbl` of stock lines: product with its option, SKU, Published/Draft (and Inactive), the count coloured by state, the alert level, the stock tag, and "Update stock" and "History".
  - On a phone, `mrow` rows. Empty states per tab.
  - A cursor pager that also steps back.
  - The linked single stock line (`?variant=`, parity G-A2) shows as a note with "Show all stock".
- **Update stock drawer:** the prototype's `adjBody`:
  - The item with an "Open" link to its product.
  - The `seg` choice of Add stock, Remove or Set exact count.
  - A stepper with quick amounts.
  - The balance it leaves (`stockAfter`), with its future state (`stockStateFor`, the server's rule, unit-tested).
  - The out-of-stock note, a refusal to remove more than is on hand, the removal reason, and the note.

  The requests, command IDs (one per opened change, renewed when the payload changes) and ledger rules are unchanged. A saved change raises the prototype's toast, "SKU: before → after".

- **History:** a drawer with the movements (change, reason and note, who, when, balance after).
- **Fixed for every rebuilt screen:** a compact notice showed "Change saved." as an error with Reload. It now shows as a success note without Reload (`SAVED_MESSAGE`).
- **Not carried over:**
  - Counts on the tabs and the units total. The inventory API returns no counts.
  - The category filter. The API filters by product, not category.
  - Thumbnails. Stock lines carry no image.
  - The quick stepper in the table. Removing or setting stock always needs a note, so every change goes through the drawer.
  - Changing the alert level in the drawer. It is the option's field, saved with its version in the product editor.
  - Export CSV. Reports has the inventory report.

## V-A6 (admin categories and brands), 2026-10-22

- **Both screens:**
  - The back link to Products.
  - The page head with New category or New brand.
  - The tabs, with Trash.
  - A search box filtering the loaded page.
  - Empty states, and a cursor pager that also steps back.
- **Categories:** the prototype's `VIEWS.categories` list:
  - Each row has the image tile (or a folder icon), the name, the `/category/` link, the published product count and the display order.
  - The "Show in store" switch (hidden on a phone, as in the prototype), Edit, and Move to trash.
  - Trash rows have Restore and the Owner's Delete permanently.
- **Brands:** the prototype's `VIEWS.brands` card grid:
  - Each card has the logo (or an award icon), the name with an Active/Inactive tag, the description, the published product count and the `/brand/` link.
  - The "Show in store" switch, Edit, and Move to trash in the card foot.
- **Drawer:** the prototype's `beBody`/`ceBody`:
  - The logo or image, uploaded in the drawer.
  - The name, a slug in an affix (read-only for staff once it exists), the description for brands, display order, and Active.
  - SEO title and description for the Owner.
  - Create brand/category or Save changes.
- **The switch:** it sends the same update with only `active` changed. SEO fields and the image are left out, so they stay as they are.
- **Images:** the image field is the prototype's drop zone, with the preview, "Replace image" and "Remove image". List thumbnails come from the same signed preview link. The upload and processing flow is unchanged.
- **Not carried over:**
  - Tab counts. The lists are paged, with no totals.
  - The prototype's up/down arrows for categories. Order is the display-order number: categories without one share 0, so swapping places would change nothing visible. The number is edited in the drawer.
  - The brand card's link to its products. The products list does not take a brand from the URL.

## V-A7 (admin customers), 2026-10-25

- **List:** the prototype's `VIEWS.customers`:
  - The page head and the no-accounts note.
  - "Search name or phone number", searching as you type; Enter searches at once. Phone digits still need at least three.
  - A `tbl` with the initials avatar and name, phone, orders with a Repeat tag, booked spend (Owner only, as before), last order and area.
  - A No-show tag where the customer is marked.
  - On a phone, `mrow` rows. Empty states, and a cursor pager.
- **Detail:** the prototype's `VIEWS.customer`:
  - The back link, and a page head with the large avatar, phone and "customer since".
  - WhatsApp (a plain `wa.me` link to the number: it opens WhatsApp, nothing is sent or recorded), Call, and New order.
  - KPI tiles: orders with cancellations; booked spend and average order (Owner only); last order.
  - An order history `tbl`, as rows on a phone.
  - The known delivery details as a list with the area and emirate.
- **New order:** opens the manual order with the customer's phone filled in and looked up at once (`newOrderForPhone`, unit-tested; `?phone=` on the new-order link). The prototype's `orderFor` does the same.
- **Not carried over:**
  - Sorting the columns. The API orders by newest customer and pages by cursor.
  - Totals in the page head (customer and repeat counts). The API returns no counts.
  - Export CSV. Reports has the customers report, behind `customers.export`.
  - Favourite products and the item list per order. The customer API returns neither.

## V-A8 (admin reviews), 2026-10-25

- **Layout:** the prototype's `VIEWS.reviews`:
  - A page head with the published average and count.
  - Status tabs with counts. The API returns them; All is their sum.
  - Product and rating `fsel` filters.
  - Review cards (`rv`): the star icons, the title, and a status tag with its icon (Pending, Approved · visible, Rejected · hidden).
  - Under each card: the body, the product link, the author, the time, and "Verified order" with the order link.
  - Approve, and Reject or Hide (reject), as prototype buttons. A toast confirms each decision.
  - Empty states, and the cursor pager.
- **Approve all:** shown on the Pending tab when more than one review is listed. After a confirmation, it approves each listed review in turn on the version shown, stops at the first refusal, and reports how many were approved. No new API.
- **Not carried over:**
  - Delete. Reviews are kept as records (ADR 0063).
  - The toast's Undo. A decision cannot be undone back to Pending; the opposite decision is the way back.
  - Product thumbnails next to the product name. The review API has none.

## V-A9 (admin discounts), 2026-10-25

- **List:** the prototype's `VIEWS.discounts`:
  - The page head with New coupon.
  - Tabs All, Active, Inactive, Expired with counts, plus Trash. The status tabs filter one page of up to 100 coupons (`couponGroup`, unit-tested). Active is `live`; Inactive is `inactive` or `scheduled`; Expired is `expired` or `used_up`.
  - A `tbl` with the code chip, percentage, minimum order, and validity (starts, until, "N days left" from 14 days, ended).
  - Uses against the limit, and the status tag with its icon.
  - The active switch (not on expired), Edit, and Move to Trash. Trash rows have Restore as inactive.
  - On a phone, `mrow` rows. The empty state with New coupon, and the help line.
- **The switch:** it sends the coupon's own saved terms with only `active` changed (`couponActiveCommand`, unit-tested). Nothing is round-tripped through the form, so the dates keep their seconds.
- **Drawer:** the prototype's `cpBody`:
  - The code, with "Generate": eight characters from `crypto.getRandomValues`, without look-alike letters.
  - The percentage and the minimum in affixes, start and end, and the usage limit.
  - The prototype's live sentence (`couponPreview`, unit-tested), with the saving rounded half-up in fils.
  - New: Save inactive or Create & activate (the pressed button sets `active`). Edit: Save changes, which keeps the on/off state.
- **Not carried over:**
  - The internal discount name. Coupons have only a code.
  - Delete. Trash keeps a coupon restorable.
  - A date-only expiry fixed at 11:59 pm Dubai. Start and end stay date-time fields in the device's time zone, as before.

## Consequences

- The look comes from the approved source instead of being re-imagined in utilities, so later screens are mostly markup work.
- Pages carried over lose their Tailwind classes; mixed pages keep working because the prototype rules are layered below the utilities.
- Media queries include the scrollbar width on desktop browsers with classic scrollbars, so breakpoints can trigger up to about 15 px earlier than in the prototype frame.
- Browser and age-preview checks match prices as `AED </span></span>49` or ignore whitespace, because the sign is drawn and "AED" is hidden text.
