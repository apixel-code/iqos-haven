# 0105 — Shop-style home page, designed hero banners, shorter quick add

- Status: Accepted
- Date: 2026-11-03
- Decided by: Marina (client feedback)

## Context

After the launch fixes (ADR 0102), the client reported four storefront problems:

1. **The hero does not fit phones.** The prototype slide keeps a 340 px height with a large circle in its lower half. With no product picture, that half reads as an empty block on a phone. The client also wants to place their own designed banners, with the text inside the picture.
2. **Adding to cart on a phone still takes the old steps.** On a product page, adding gives one toast (ADR 0102). From a product card, "+" opens the quick-add sheet. After adding there, the sheet closed and a toast appeared, and the shopper then had to open the cart.
3. **"Shop by brand" looks wrong.** The store sells two brands, IQOS and TEREA. The prototype's row of small tiles with "All brands" does not suit that.
4. **The home page should be a full shop.** It should have product rows for category, best sellers, featured, new arrivals and recently viewed. Before this, one "Popular right now" box held three lists behind a toggle.

Marina's choices: designed banners as pictures, with a separate phone picture; and one-tap add from the card whenever there is nothing to choose.

## Decision

### Hero

- **Phones (< 720 px):**
  - a text slide is only as tall as its words
  - the product picture sits in the flow under the words
  - the supporting text is shown
  - the circles shrink to a corner accent
- **Designed banner:** hero content schema **v3** adds the look `banner` and an optional `mobileImage` per slide.
  - A banner needs its wide picture (1920 × 640 recommended). It is shown edge to edge at its own proportions, capped at 560 px high on wide screens.
  - The optional phone picture (1080 × 1080) is served to screens below 720 px through `<picture>`.
  - The whole banner is the link of its first button.
  - The headline is still required, but it is shown only to screen readers and search engines.
  - The carousel controls sit on a dark pill so they stay readable over any picture.
  - Hero v1 and v2 documents upgrade to v3 with `mobileImage: null`; a stored document is never rewritten.
  - The admin editor has a "Designed banner" look with its own image hints and a "Phone picture" field.

### Quick add

- **Nothing to choose:** on a card, "+" adds at once with the usual toast and Checkout action. This applies when every option has a single value on offer and the item is in stock. The same selection rules as the product page decide this, so no variant is ever chosen for the shopper.
- **Something to choose:** the sheet opens as before. After adding, the **same sheet** shows "Added to cart" with **Checkout** and **Continue shopping**. No toast appears on top of it, and no second popup opens.

### Shop by brand

- With up to two brands, each brand gets a wide showcase card. The card has the brand's logo or name, the first sentence of its description, a product count, a product photo from the page, and its own "Shop …" button.
- The first card is dark and the second light. They sit side by side from 720 px and stack on phones. One brand fills the row. A card without a photo shows its words only.
- With more brands, the prototype tiles return.

### Home page

The order is:

1. Hero and trust line
2. Shop by category
3. **Best sellers**
4. **Shop by brand**
5. **New arrivals**
6. **Featured**
7. **TEREA Sticks** (8, by name)
8. **IQOS Devices** (8, cheapest first)
9. Campaign banners and offers
10. **Recently viewed**

- Each product row has a heading, a line below and a "see all" link. It is a swipeable row on phones and a grid of four from 1040 px.
- A row with nothing to show is left out.
- The "Popular right now" toggle (`PopularProducts`) is removed.

## Consequences

- The home page makes two more catalogue reads on the server: products by type for sticks and for devices. They use the same API and the same budget as the existing reads.
- `scripts/check-age-preview.mjs` gains a banner slide. Its check covers the wide and phone pictures and the whole-banner link. The home copy checks now expect "New arrivals" and "Best sellers".
- **Browser QA:**
  - New `scripts/browser-qa/home-shop.mjs` covers the sections, the brand cards, the hero height on a phone and quick add ending in Checkout, at 360 and 1280 px.
  - `cart-sheet.mjs` expects the in-sheet "Added" view.
