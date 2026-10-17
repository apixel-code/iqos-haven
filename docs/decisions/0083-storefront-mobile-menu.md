# 0083 — Storefront mobile menu sheet

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-S4 (follows ADR 0033)

## Context

On a phone the store header wrapped its five section links, Saved and Cart onto several rows. Compare, Help and WhatsApp were not in the header at all. The prototype (`menuSheet`) keeps the phone header to the logo, menu and cart, and puts the sections, a brands list, saved items, compare, help and WhatsApp in a sheet from the left. Marina chose G-S4 as the last of the four tier-L parity gaps to build before step 120 (2026-10-17).

## Decision

**Phone header (below `md`, 768px).** The logo, a "Menu" button and Cart sit on one row, with search on its own row below. The section links and Saved are hidden there. From `md` up the header is unchanged, plus a "Help" link.

**`MenuSheet`.** A native modal `<dialog>` from the left, full height, at most 22rem and 86% of the width. It contains:

- Home and the shop sections (from `PRIMARY_NAV`);
- **Brands**, a disclosure (`<details>`) listing brands with products and "View all brands";
- **Saved items** and **Compare kits**, with this device's counts;
- **Help & info**, a disclosure with delivery, FAQ, contact and the three policy pages;
- **Chat on WhatsApp** (the general message), shown only when a number is set.

How it behaves:

- **Closing:** focus moves in. Escape, the close button or a click outside closes the menu and returns focus to the Menu button. Following a link closes it, and so does a route change (Back or Forward).
- **Brands load on demand:** they are read from `/api/v1/store/brands` when the menu first opens (the API checks the age ticket), with loading, failure and "Try again" states. The store layout does not call the API for every page.
- **No product data before age verification:** the menu renders nothing until it is opened, on routes that already require the age ticket.

## Consequences

- The phone header is one compact row plus search. Every destination of the prototype's menu is two taps away.
- Brands appear only after the first open has loaded them. If that fails, "Try again" asks again; nothing is cached on the device.
