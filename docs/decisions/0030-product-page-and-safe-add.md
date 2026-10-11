# 0030 — Product page, option selection and safe add-to-cart

- Date: 2026-10-11
- Status: accepted
- Step(s): 61 (cart UI: 62; wishlist/compare/recently viewed: 63; shell and WhatsApp: 64; server quote: 65+)

## Context

Roadmap step 61: product detail, option selector, gallery and safe quick add, where stock and price are variant-specific and a required choice is never silently substituted. Acceptance CAT-02 says the same for unavailable variants: explain the state, never choose another flavour.

## Decision

**Selection rules** (`lib/store/selection.ts`, pure and unit-tested, shared by the product page and quick add):

- The variant is the one whose attributes match every chosen option exactly. There is no "closest" match.
- If the choices do not single out exactly one variant (two variants the options cannot tell apart), nothing is offered.
- A sold-out combination resolves to _sold out_; a combination no active variant has resolves to _unavailable_. Neither is replaced by another variant, and the shopper's choices stay as they are.
- Nothing is chosen for the shopper when an option has more than one value on offer. An option with a single value is filled in, because there is nothing to choose.
- Price, previous price, saving and stock line come from the resolved variant. Before a variant is resolved the page shows the lowest price, with "From" when prices differ.

**Departure from the prototype.** The prototype preselects the first in-stock flavour and the first nicotine strength. Here nothing is preselected: adding a 50 mg product because 20 mg happened to be listed second is exactly the silent substitution the roadmap forbids. Pressing "Add to cart" without choosing says "Choose flavour and nicotine first." and adds nothing.

**Product page** `/p/[slug]` (server-rendered, gated): breadcrumb, gallery, brand, name, buy box, description, specification rows with the prototype's labels (only rows that have values), and up to four more products of the brand. A former slug answers 308 to the current one; an unknown product is a real 404; a slug that cannot exist makes no API call. The product name appears in the page title for verified shoppers only; link previews stay generic (ADR 0026).

**Buy box:** options as radio groups styled as chips (sold-out or unoffered values are struck through and announced to screen readers, and remain selectable so the state can be explained), quantity 1–10, and one button: "Add to cart", "Sold out" (disabled) or "Not available" (disabled).

**Quick add** on product cards (hidden for sold-out products) loads the product from the same-origin API route, which checks the age ticket again, and opens the same buy box in a dialog. A variant is therefore only ever added by the same explicit choice. If the product cannot be loaded there, the shopper is taken to the product page.

**Device cart** (`lib/cart/`): `ih_cart_v1` in localStorage holds variant ID, product slug, quantity and a display snapshot (name, brand, option text, price in fils). Strict schema on read: anything else, including any extra field, makes the stored value an empty cart. Limits: 10 per variant, 50 different variants. The same variant merges into one line. No name, phone, address or other shopper data is stored, and nothing is written to sessionStorage. A small component on every page, including the age check, removes the prototype’s `co` and `lastOrder` keys from local and session storage. If the browser refuses to store the cart, it is kept in memory for the page instead of silently reverting. Prices in the cart are a preview; the server quote (step 65+) decides what is charged and whether a line can still be bought.

**No new dependency.** The cart store uses React's `useSyncExternalStore` instead of Zustand (architecture §4 names Zustand); the behaviour asked for is the same and the store is about sixty lines. Revisit if device state grows in step 63.

## Not built here

- Cart page, header cart count, editing and removing lines (step 62). The add confirmation therefore has no "View cart" link yet.
- Wishlist heart, compare, recently viewed (step 63). WhatsApp links (step 64; the number is a business input).
- Reviews and ratings (later milestone; the prototype's are demo content).
- The prototype's delivery promise and "genuine stock" lines are placeholders and are left out. The nicotine warning sentence is the prototype's wording, pending BI-04.
- Swipe gestures and zoom in the gallery.

## Alternatives considered

- **Preselecting the default variant.** Rejected, as above.
- **Disabling sold-out option values.** Rejected: a disabled control cannot explain itself, and CAT-02 asks for an explanation.
- **Adding directly from the card for single-variant products without loading the product.** Rejected: the card does not carry variant IDs, and one code path is easier to keep safe.

## Consequences

- Quick add needs the browser to reach `/api/v1/store/products/:slug` through the gateway; elsewhere it falls back to the product page.
- Availability on the page can lag a stock change by up to the API cache TTL (60 s); the quote and order steps re-check against the database.
- A cart line can outlive its variant (deactivated, product unpublished). Step 62 must show such lines as unavailable using the same "never substitute" rule.
