# 0087 — Mobile search sheet

- Date: 2026-10-17
- Status: accepted
- Step(s): parity gap G-S3 (follows ADRs 0029 and 0083)

## Context

On a phone, search was the header's inline box with a small suggestions dropdown. It showed nothing before typing and had no way to see all results except pressing Enter. The prototype (`searchSheet`, `searchResults`) opens a full-screen sheet. Before typing it offers brands and recently viewed products; while typing, matching brands and products, then "See all N results". Marina chose G-S3 for launch (2026-10-17).

## Decision

- **Phone header:** below `md` the header has a **Search** button next to Menu and Cart. The inline box remains from `md` up.
- **`SearchSheet`:** a native modal `<dialog>` covering the screen, with the field focused. It is the same plain GET form to `/search`, so Enter always searches.
  - **Before typing:** the brands that have products (loaded when the sheet first opens, with loading, failure and retry states), and up to three products recently viewed on this device, read fresh through the age-gated cards route.
  - **While typing** (two characters or more): suggested brands and products from the existing suggest route, and "See all results for …". The suggest answer has no total, so there is no count.
- **No "Popular searches":** the prototype's list is invented demo copy. There is no approved list or ranking to show.
- **Closing:** a link, a route change, Escape (focus returns to the Search button) or Cancel. A late `close` event is ignored while the dialog is open, as in the cart sheet and menu (ADR 0084).
- **Shared hooks:** `useSuggestions` (search box and sheet) and `useStoreBrands` (menu and search sheets) live in `lib/store/client-hooks.ts`.

## Consequences

- Phone shoppers get a full-screen search with something useful before typing. Nothing new is stored on the device; recently viewed already existed (ADR 0032).
- One more sheet in the header; the inline box's behaviour on wider screens is unchanged.
