# apps/storefront — Next.js App Router + Tailwind

- No business logic. Prices, stock, totals, coupons, order state come from the API. Never compute a payable total client-side except for display of the server quote.
- Allowed server code here: age-ticket signer route handlers (accept/reject), `proxy.ts` routing gate, metadata/robots/sitemap handlers. Nothing else talks to the DB.
- Age gate: product name/image/price/JSON-LD must not appear in HTML, RSC payload, metadata or OG tags before a verified cookie. Generic preview only. No user-agent bypass.
- Product/catalogue fetches: `cache: "no-store"` / private. Don't add a second persistent cache.
- Device state (cart variant IDs, wishlist, compare, recently viewed) may use localStorage. Checkout name/phone/address: React state only. Remove legacy `co` key on load.
- Checkout attempt key: generated once per attempt, survives refresh, reused on retry.
- Cart clears only after the API acknowledges the order.
- Design tokens/components from `packages/tokens` + `packages/ui-core`; fonts Poppins + JetBrains Mono (see prototype head).
- Prototype reference: `docs/prototypes/storefront.html` via `docs/prototype-map.md`. Storefront routes in prototype: home, shop, brands, pdp, cart, checkout, done, wishlist, compare, help + sheets (cart, search, menu, filter, quick-add, WhatsApp).
- Every page needs loading / empty / error states and must work at 360px width.
