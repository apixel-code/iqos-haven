# 0088 — Sticky add-to-cart bar on phones

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-S5 (follows ADRs 0031 and 0082)

## Context

On a phone, the product page's Add to cart button scrolls away as the shopper reads the description and reviews, and they have to scroll back up to buy. The prototype (`.satc`) shows a bottom bar once the main button has gone off the top: the product name, the chosen option and price, a WhatsApp button and Add to cart. Marina chose G-S5 for launch (2026-10-17).

## Decision

- **Inside `BuyBox`:** the bar shares the option choice, quantity and add logic. It exists only on the product page (not in quick add) and only below `md`.
- **When it shows:** once the main Add to cart button has scrolled up out of view (an IntersectionObserver). It slides in, or appears without motion under reduced motion. While hidden it is inert, and its controls are not rendered, so with the main button on screen the page has a single Add to cart.
- **Contents:**
  - the product name;
  - the price first (it is never the part cut off), then the chosen option or "Choose an option";
  - a WhatsApp button with the product message, when a number is set;
  - Add to cart, which reads Sold out or Not available when that applies.
- **No silent default:** the prototype adds its first option when none is chosen. Here the bar scrolls to the first unchosen option and focuses it, and the usual "Choose … first" message appears. A variant is only ever added by an explicit choice, as on the main button (ADR 0031).
- **Room below the page:** while the bar exists on a phone, the page gets bottom padding, so at the end of the page the bar never covers the footer, including the nicotine warning.

## Consequences

- Phone shoppers can add from anywhere on the product page. The add, quantity and cart-sheet behaviour are the main button's.
- Browser passes that look up "Add to cart" still find exactly one button while the main one is on screen.
