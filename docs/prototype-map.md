> Line numbers are navigation hints from the original prototype; use the named symbol with `rg -n` after edits.

# Prototype map — look up here before touching the HTML

Never read a prototype whole. Find the symbol here → `grep -n "<symbol>" docs/prototypes/<file>` → read ≤150 lines.
Line numbers are approximate (from the approved prototype, 6 Oct 2026); always re-grep.

## Shared (both files)

| What                    | Where                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Fonts                   | `<head>` ~L39–44: Poppins 300–700, JetBrains Mono 400–500                                      |
| Design tokens           | first `:root` blocks ~L10–120 (admin also has dark theme `:root[data-theme="dark"]` ~L118–200) |
| Component CSS           | grep the class name inside `<style>` (storefront CSS ends ~L5811, admin ~L4315)                |
| Icons / placeholder art | `ico`, `art`, `artBox`, `tileBg`, `hsl`                                                        |

## Storefront — `docs/prototypes/storefront.html` (script ~L5994–9590)

| Area                        | Symbols (≈ line)                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helpers / money             | `esc`, `money` 6017, `aed` 6028, `r2` 6016                                                                                                                              |
| Demo data (DON'T copy)      | `BRANDS` 6088, `P` 6133, `AREAS` 6494, `PROMOS` 6541 (HAVEN10; percentage only)                                                                                         |
| Persistence (trap)          | `persist` 6743, `store.set("co"` 6749, sessionStorage 6705 / 8698 / 9293                                                                                                |
| Variants                    | `variantOf` 6754, `vLabel` 6761, `vKey` 6764, `vOos` 6767                                                                                                               |
| Cart & totals               | `cartCount` 6773, `subtotal` 6774, `promoEval` 6776, `totals` 6808, `addToCart` 6824, `fly` 6891                                                                        |
| Wishlist / compare / recent | `toggleWish` 6950, `toggleCompare` 6980, `addRecent` 6996                                                                                                               |
| Search & facets             | `search` 7005, `match` 7050, `results` 7069, `facetCount` 7083, `activeCount` 7092                                                                                      |
| Router / render             | `nav` 7121, `back` 7198, `render` 7226, `view` 7297                                                                                                                     |
| Age gate                    | `gateShell` 7326, `gate` 7334, `restricted` 7348                                                                                                                        |
| Shell                       | `promoBar` 7363, `header` 7369, `coHeader` 7403, `footer` 7412                                                                                                          |
| Cards                       | `stars` 7434, `priceBlock` 7440, `card` 7446, `skCards` 7463 (skeleton)                                                                                                 |
| Home                        | `home` 7478, `heroBanner` 7576, `setupHero` 7620, `catTiles` 7676, `featBox` 7716, `faqItem` 7720, `waBand` 7723, `brandTile` 7726, `campaign` 7730                     |
| Shop / listing              | `shopTitle` 7741, `shop` 7774, `chips` 7827, `emptyResults` 7843, `filterBody` 7850                                                                                     |
| Brands page                 | `brandsPage` 7884                                                                                                                                                       |
| Product detail              | `pdp` 7893, `rerenderPdp` 7983, `reviews` 8007                                                                                                                          |
| Cart page                   | `cartLines` 8030, `freeDel` 8042 (hide while disabled), `promoBox` 8047, `totalsBlock` 8055, `emptyCart` 8059, `cartPage` 8070, `waOrderBtn` 8081                       |
| Checkout                    | `checkout` 8085, `fld` 8091, `validate` 8147, `applyPromo` 9092, `clearErr` 9062                                                                                        |
| Confirmation                | `done` 8173                                                                                                                                                             |
| Wishlist / compare / help   | `wishlist` 8195, `comparePage` 8201, `help` 8245                                                                                                                        |
| Sheets (mobile)             | `openSheet` 8390, `cartSheet` 8478, `searchSheet` 8488, `searchResults` 8506, `menuSheet` 8553, `filterSheet` 8570, `quickSheet` 8579, `waSheet` 8621, `waMessage` 8601 |
| Feedback                    | `toast` 8637, `bump` 8656, `copyText` 8665                                                                                                                              |
| Demo brief panel (ignore)   | `renderBar` 9241, `openBrief` 9309, `brief` 9344                                                                                                                        |

## Admin — `docs/prototypes/admin.html` (script ~L4663–13510)

Pages are `VIEWS.<name>`; grep `VIEWS.orders` etc.

| Page / area                    | Symbols (≈ line)                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Demo data (DON'T copy)         | `rng` 4718, `mkPhone` 5721, `addCus` 5725, `mkHistory` 5822, `mkOrder` 5881, `simulateOrder` 12350                                  |
| Permissions matrix (reference) | `PERMS` 11724, `can(` grep, `denied` 6560                                                                                           |
| Router / shell                 | `go` 6318, `render` 6376, `navItems` 6410, `navHtml` 6492, `shell` 6510, `pageHead` 6555, `routeName` 6566                          |
| Overlays                       | `openLayer` 6583, `modal` 6628, `drawer` 6631, `confirmDlg` 6641, `openPop` 6671, `toast` 6751, `busy` 6776                         |
| Date range / metrics           | `rangeOf` 6805, `rangeBtn` 6873, `metrics` 6920, `deltaHtml` 6941, `series` 6990                                                    |
| Charts                         | `chartBox` 7033, `drawChart` 7057, `spark` 7148                                                                                     |
| Table utils                    | `emptyState` 7177, `pager` 7180, `sortTh` 7216                                                                                      |
| Dashboard                      | `VIEWS.dashboard` 7271, `openOrders` 7245, `delayed` 7250, `lowList` 7258, `greet` 7263                                             |
| Orders list                    | `VIEWS.orders` 7481, `orderRowM` 7477                                                                                               |
| Order detail                   | `VIEWS.order` 7756, `setStatus` 7725 (trap: "Collected"), `fillTpl` 7749 (WhatsApp templates)                                       |
| Order edit                     | `VIEWS["order-edit"]` 8034, `editTotals` 8114, `editItems` 8126, `editSum` 8137                                                     |
| Manual order wizard            | `VIEWS["order-new"]` 8340, `noState` 8306, `noTotals` 8331, `noRes` 8431, `noItems` 8448                                            |
| Products list                  | `VIEWS.products` 8736                                                                                                               |
| Product editor + media         | `VIEWS.product` 9038, `peInit` 8961, `peImg` 9011, `peMedia` 9033, `mediaRefresh` 9189, `addFiles` 9243, `bindMedia` 9265           |
| Inventory                      | `VIEWS.inventory` 9422, `adjBody` 9542, `adjPrev` 9563, `adjNew` 9572                                                               |
| Categories                     | `VIEWS.categories` 9641, `ceBody` 9715                                                                                              |
| Brands                         | `VIEWS.brands` 9852, `beBody` 9911                                                                                                  |
| Customers                      | `VIEWS.customers` 10054, `VIEWS.customer` 10106, `cusStats` 6077                                                                    |
| Reviews                        | `VIEWS.reviews` 10166                                                                                                               |
| Discounts                      | `VIEWS.discounts` 10265, `cpBody` 10352, `cpSentence` 10366                                                                         |
| Analytics                      | `VIEWS.analytics` 10506, `anOverview` 10584, `anSales` 10614, `anProducts` 10660, `anSearch` 10700, `anWish` 10742, `kpiTile` 10581 |
| Reports / CSV                  | `VIEWS.reports` 10961, `csvData` 10807                                                                                              |
| Storefront content             | `VIEWS.content` 11084, `ctDraft` 11058, `ctMark` 11164                                                                              |
| SEO                            | `VIEWS.seo` 11406, `seoPages` 11331, `seoIssues` 11398, `seBody` 11447                                                              |
| Settings                       | `VIEWS.settings` 11496, `setTouch` 11605                                                                                            |
| Staff & roles                  | `VIEWS.staff` 11738, `sfBody` 11808                                                                                                 |
| Notifications                  | `VIEWS.notifications` 11888, `notifItem` 12317, `notifPanel` 12320, `pushNotif` 6213                                                |
| Auth                           | `authView` 12161, `pwRules` 12187, `signOut` 12300                                                                                  |
| Theme / search                 | `applyTheme` 12461, `searchHtml` 12480                                                                                              |
| Demo-only (ignore)             | `guideView` 11891 + `g*` helpers, `applyDev` 12629, `loginAs` 12676, `setDev` 13260, `flowRun`/`coach*`/`flow*` 13278–13390         |
