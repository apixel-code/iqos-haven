# UI and design handoff

The two HTML prototypes remain interaction/visual references, not production commerce code. Figma is optional. The launch React screens are still pending; the existing two app home pages are foundation shells. Use `requirements.md` for screen/action scope and `acceptance.md` for failure/permission states.

## Reference locations

- Store: `docs/prototypes/storefront.html`; `prototype-map.md` indexes home/shop/brands/PDP/cart/checkout/done/wishlist/compare/help and sheets.
- Admin: `docs/prototypes/admin.html`; map lists dashboard/orders/order detail/edit/manual order/products/editor/inventory/categories/brands/customers/reviews/discounts/analytics/reports/content/SEO/settings/staff/notifications/auth.
- Tokens: `packages/tokens`; Poppins/JetBrains Mono through installed Fontsource packages; retain font licenses. Both admin themes share semantic token names.
- Implemented shared components: see `packages/ui-core/src`; this is the component base, not a complete design system certification.

## Required production adaptations

| Prototype concept                     | Final behavior                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Browser age flag                      | Signed server cookie/ticket, verified API/RSC/metadata/cache boundaries            |
| Product-level opening stock           | Variant rows with SKU/signature/price override/stock/threshold/version             |
| Delivered implies Collected           | Separate explicit collection action/amount; Owner-only correction                  |
| Checkout persistence                  | Memory-only PII; legacy co and lastOrder removal; durable non-PII attempt key only |
| Fixed/brand coupons/free progress     | Percentage only; threshold off until approved                                      |
| Demo login/role switch/random metrics | Actual identity/RBAC/data; never production bypass                                 |
| Per-record shared notification read   | Per-user receipts and scope                                                        |
| Arbitrary status/edit controls        | Versioned legal commands; 403/409/retry handling                                   |
| Product-rich preview                  | Approved generic logo/name preview only                                            |

In this fix package the storefront prototype clears legacy co/lastOrder and no longer persists them. Unsupported demo coupons/free progress are disabled. The admin prototype delivery action no longer records cash; an explicit demo collection control was added. Prototype-generated historical sample orders are still fictional. Demo stock, auth, sessionStorage gate, random data and notifications remain references only; they are not served by either Next app.

## Component/state checklist

Implement accessible labelled inputs/selects/textarea, inline errors, busy/disabled buttons, focus-managed dialogs, mobile sheets, table sorting/paging, skeleton, empty/error/retry notices, toast/live region and version-conflict reload UI. Use committed API responses for stock/status mutations. Never show optimistic success for financial or inventory commands.

Verify 360px storefront/admin usability, agreed desktop widths, long table overflow, keyboard order, focus return, screen-reader error associations, dark-theme contrast, touch targets and reduced-motion. Capture approved comparisons for each implemented screen; no visual/accessibility sign-off has been performed just by shipping HTML.

## Assets register

| Asset                                | Status / source                 | Requirement                                                                       |
| ------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- |
| Brand logo/favicon/generic OG logo   | Client needed, BI-01            | Approved identity, light/dark readability; generic preview contains no product    |
| Product photos per SKU/product       | Client needed, BI-10            | Licensed source, approved crop/alt, observed MIME/dimensions, ≤8 published images |
| Hero/campaign/category/brand visuals | Prototype art only              | Approved copy/image manifest; references survive draft/publish validation         |
| Icons                                | Prototype inline SVG references | Reusable accessible icon components; appropriate decorative vs labelled use       |
| Fonts                                | Fontsource dependencies         | Self-host; retain licensing; no runtime Google Fonts dependency                   |

Add an asset's filename/key, owner, approval date, intrinsic size, alt text, usage permission and protected/public classification when supplied. Do not substitute demo art for approved catalogue without recording the decision. Primary product derivatives require the age/cache strategy; quarantined originals and reports stay private.
