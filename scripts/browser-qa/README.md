# Browser QA harness (admin, through the real local gateway)

Headless Chromium drives the admin origin `http://localhost:8081` (Caddy gateway) against a
built API and the real worker consumers (media processing, signed cache invalidation) on an isolated `ih_test_*` schema of the **test** database.
The dev database is never touched; only synthetic accounts are created. Used for steps 42–51
and the step 54 acceptance pass (see `docs/verification.md`, "Browser QA").

## One-time setup (outside the repo; not a project dependency)

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"
mkdir -p /tmp/ih-qa && (cd /tmp/ih-qa && npm init -y >/dev/null && npm i playwright-core@1)
# Chromium: the cached Chrome for Testing in ~/Library/Caches/ms-playwright is used by default;
# set QA_CHROMIUM to another Chromium executable if needed.
```

## Run

```sh
pnpm infra:up && pnpm build                       # infra + built api/worker/admin (or pnpm verify)
node scripts/browser-qa/qa-server.cjs &           # prints "QA backend ready on :4000 schema=ih_test_…"
APP_ENV=staging API_INTERNAL_URL=https://api.internal.invalid pnpm --filter @ih/admin start &
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/qa.mjs   # PASS/FAIL per check; screenshots in /tmp/ih-qa/shots
```

Afterwards stop both servers and drop the schema:
`node scripts/browser-qa/qa-server.cjs --drop ih_test_<id>`.

Notes: ports 3001, 4000 and 4099 (loopback QA status probe: counts only) must be free; the `API_INTERNAL_URL` value is a placeholder required by
the production admin start (the admin client only calls the same-origin `/api`). Real mobile
touch/keyboard and reset/invite submissions are not covered.

## Storefront shopper journey (steps 80–82, M7 gate)

`checkout.mjs` drives the whole journey at 360px against the stack served by the gate script:

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # prints SERVING, VARIANT, SCHEMA
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/checkout.mjs <SERVING> /tmp/ih-qa/shots <VARIANT> <SCHEMA>
```

Age check, product, variant, cart, quote, checkout form, a lost answer, a reload, an attempt that
was already placed, the confirmation page and its expired state, then a second order through a
changed total and a sold-out line. It changes the price and stock mid-journey with `psql` through
`docker exec` (override with `QA_PSQL`). The age answer is posted with the storefront's https
Origin, because the served storefront refuses the local http one; the button is not clicked.
The served stack also runs the worker's relay, queue and consumers on that schema (a private
queue prefix), and the journey checks that both orders reach the inbox. Stop the stack with
SIGTERM (`kill <pid>`): it stops the storefront's process group and the gateway container,
then drops its schema and queue keys (step 121 fixed a shutdown hook that skipped this).

## Review link page (step 94)

`review.mjs` runs after `checkout.mjs` on the same served stack (it needs a placed order):

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/review.mjs <SERVING> /tmp/ih-qa/shots <SCHEMA>
```

It takes the newest order to Delivered and creates a review link with the real `@ih/db` commands
(built packages, the served schema of the test database), then opens `/review#<token>` at 360px:
the page HTML holds no product, the token leaves the address bar and never reaches an API URL,
a Referer or device storage, an empty form sends nothing, a review is stored pending, the worker
writes the moderators' inbox notification, and a reload or the used-up link says it can't be used.
The age question's fragment hand-over is not covered here (the served gate redirects to the
https origin); it was checked once in Chromium with a stand-in server (docs/verification.md).

## Admin Reviews screen (step 95)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/admin-reviews.mjs <SCHEMA>
```

It creates two pending reviews with the real database commands (delivered order, review link,
submission), then the Owner approves one and rejects the other in the browser. It checks the
tabs and counts, the published average, the empty states, the filters, the stored statuses and
the 390px layout. Staff see no Reviews link and get "Access unavailable".

## Storefront content editor (step 97)

With `qa-server.cjs` and the admin running as above (fresh schema: it expects unsaved sections):

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/content-editor.mjs <SCHEMA>
```

The Owner edits the promotional bar (markup refused in the form), saves, previews and publishes.
Featured products: a product hidden after being picked blocks publishing and is named. Hero: a
button and an uploaded image, processed by the qa-server worker, then previewed and published.
It also checks unsaved and discard states, the stored typed data, one `content.published` per
publish, 390px layout, and that Staff cannot open the editor.

## Home page with published content (step 99)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve &          # prints SERVING and SCHEMA
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/home.mjs <SERVING> /tmp/ih-qa/shots <SCHEMA>
```

It publishes every section with the real storage commands on the served schema, waits out the
API cache (up to 60 s), then checks the hero, promotional bar, banner and offers at 360px,
1280px and 360px with reduced motion: the ticker moves only without reduced motion, the pause
button stops it, no horizontal scroll and no page errors. Stop the stack with SIGTERM and drop
the schema.

## Storefront telemetry (step 104)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # SERVING, SCHEMA
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/telemetry.mjs <SERVING> <SCHEMA>
```

It searches, opens a product, saves it and adds it to the cart at 360px, then checks the events
on the served schema (normalized term, no personal fields, device keys limited to cart, lists
and the anonymous ID). The checkout page must send nothing. With the events route answering 503,
adding to the cart stays immediate, checkout opens, the route is not hammered, and there are no
page errors.

## Home dashboard and Owner analytics (steps 108–109)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/dashboard.mjs <SCHEMA>
```

The script seeds two orders and two searches, then rolls up today.

- **Owner, home page:** open counts, the pending orders to confirm, booked sales with their freshness, and the recent orders.
- **Owner, Analytics:**
  - The booked-order count matches the database, and the tax basis is shown.
  - The daily chart has a slot per day; focusing a column reads out its value.
  - The Search tab lists the term with no results.
  - Each tab opens.
  - The 7-day range names the days that are not computed.
- **Layout:** both pages fit 390px without sideways scrolling.
- **Staff:** the operational counts, but no sales figures, no Analytics link and no access to Analytics.
- **Both roles:** no page errors.

The script can run again on the same schema.

## Reports screen (steps 110–112)

With `qa-server.cjs` (its worker loop also runs `report_builder`) and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/reports.mjs <SCHEMA>
```

The pass covers:

- **Streamed reports:** the Owner requests a sales report, which is ready at once and downloads with a named file and a UTF-8 marker.
- **Customer data:** the customers report asks first; dismissing the question sends nothing, and accepting it downloads the file.
- **Built files:**
  - A file job, queued directly in the database, is built by the worker.
  - The screen notices it by itself.
  - The file downloads through its signed storage link.
- **Audit:** every download is audited.
- **Layout:** the page fits 390px without sideways scrolling.
- **Staff:** no Reports link, no access to the screen, and 403 for the Owner's file by its ID.

The pass can run again on the same schema.

## SEO screen (step 113)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/seo.mjs <SCHEMA>
```

The pass covers:

- **Defaults:** Closed is chosen. Product indexing is listed as inactive and is not a switch. The sitemap is inactive.
- **Report:** a brand without SEO fields appears in the issue report.
- **Changing the policy:**
  - Dismissing the confirmation changes nothing.
  - Accepting it offers the public pages: the stored policy changes, the sitemap shows as active, and the change is audited.
  - Closing again works.
- **Layout:** the page fits 390px without sideways scrolling.
- **Staff:** no SEO link and no access.
- **Errors:** no page errors.

The storefront side of the policy is checked by `pnpm test:age-preview`.

## Order item picker and returning customer (parity G-A1)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/order-picker.mjs <SCHEMA>
```

It seeds a published pod with two flavours in stock and one sold out, an area and the fee. Staff
then create a manual order for a new number: the lookup says "new customer", items come from the
search (name, brand, SKU), and a sold-out or already added variant cannot be added. A second
order for the same number, typed with a leading 0, finds the returning customer, fills the name
and the saved address, and lands on the same customer. The order edit then adds a variant from
the picker. It also checks the 390px layout and that there are no page errors.

## Admin deep links (parity G-A2)

With `qa-server.cjs` and the admin running as above, on a fresh schema (other passes add low-stock lines that push this pass's line off the dashboard list):

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/deep-links.mjs <SCHEMA>
```

It seeds a delayed and a fresh pending order, a confirmed order, a low-stock line on a product
on sale, and two notifications for the Owner. It then follows each link: an order URL (reload
and Back included), the dashboard's pending, delayed, recent-order and low-stock links, the bell,
the inbox, a customer's history and a product URL. Each must open that one record or a correctly
filtered list. A malformed ID falls back to the list, and there must be no page errors.

## Storefront cart sheet (parity G-S1)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/cart-sheet.mjs <SERVING> /tmp/ih-qa/shots
```

At 360px it adds from the product page and checks the sheet: line, subtotal, the way on, focus
inside, a full-width bottom sheet, no sideways scroll, the quantity control, Escape, Continue
shopping, and View cart and checkout. At 1280px it adds through quick add (which hands over to
the sheet) and checks the full-height side panel, removing the last line and closing by clicking
outside. Neither size may have page errors.

## Storefront mobile menu (parity G-S4)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/menu-sheet.mjs <SERVING> /tmp/ih-qa/shots
```

At 360px it checks the compact header (Menu button, no section links, no sideways scroll) and
the menu: focus inside, a full-height sheet from the left, every section, the saved count, brands
loaded on opening, and that a brand or help link closes the menu. It also checks that WhatsApp
is only a wa.me link, that Escape returns focus to the button, and that an outside click
closes it. At 1280px there is no Menu button, and the sections and Help stay in the header.

## Accessibility (step 120, local part)

Install axe-core next to playwright-core (`npm i axe-core@4` in `QA_PLAYWRIGHT_DIR`). Storefront, on the served gate stack:

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/a11y-storefront.mjs <SERVING> /tmp/ih-qa/shots
```

Admin, with `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/a11y-admin.mjs <SCHEMA>
```

Both run axe-core with the WCAG 2.1 A/AA rules on every page at a phone and a desktop width (the
admin also in its dark theme). Serious and critical violations fail; lesser ones are printed as
notes. They then walk keyboard-only journeys through the dialogs, sheets and form errors.

## Listing-page filters (parity G-S2)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/listing-filters.mjs <SERVING> /tmp/ih-qa/shots
```

It checks that `/shop` offers every filter with counts, and that type, brand and offers pages hide the filter they fix. A filter submits to the page's own path, and a filter that matches nothing has a way back. Old `?brand=&sort=` links still work, a malformed cursor is ignored, and the 360px filter block opens with a count when a filter is active.

## Mobile search sheet (parity G-S3)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/search-sheet.mjs <SERVING> /tmp/ih-qa/shots
```

At 360px it checks that the header has no inline box and the sheet fills the screen with the field focused. Before typing it offers brands and the recently viewed product. Typing suggests the product and links to every result. Enter searches and closes the sheet, Escape returns focus, and a brand opens its page. At 1280px the inline box stays and there is no sheet button.

## Sticky add-to-cart bar (parity G-S5)

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve &   # prints SERVING
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/sticky-add.mjs <SERVING> /tmp/ih-qa/shots
```

At 360px the bar is hidden and inert while the main button is visible, and slides in at the bottom edge once it has scrolled away. It asks for an option and shows the price; it covers no footer text at the end of the page. With no choice it focuses the option and adds nothing; after a choice it shows option and price and adds, opening the cart sheet. At 1280px there is no bar.

## Orders list (parity G-A5)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/orders-list.mjs <SCHEMA>
```

It seeds pending and confirmed orders of different sizes. It then checks the tab counts and the header line, that "Highest amount" puts the largest order first, and that select-all chooses every pending order on the page and clears again. At 390px the cards replace the table without sideways scroll, and a tap opens the order.

## Packing slip (parity G-A6)

With `qa-server.cjs` and the admin running as above:

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/packing-slip.mjs <SCHEMA>
```

It checks the slip preview: order number, customer, area with the order's own emirate (never an assumed Dubai), item, quantity, SKU and the cash to collect. In print media only the slip is laid out, and the printed PDF is one A5 page. Staff without `customers.read` get no slip.
