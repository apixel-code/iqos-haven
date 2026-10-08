# Implementation requirements — Revision 2 reference set

Status: derived engineering requirements, 8 October 2026. Architecture is approved; business inputs in `business-inputs.md` remain OPEN. This document specifies work, not a claim that the features are implemented. Resolve disagreements in favour of `architecture.md`, then update this document and acceptance criteria together.

## Launch scope

English, Dubai only, approximately 50 products, guest COD checkout, 18+ gate, percentage coupons, one approved flat delivery fee, Owner/Staff. No customer accounts, online payments, WhatsApp Business API, custom roles, MFA, fixed/brand-specific coupons or cross-device confirmation. Product indexing starts disabled; generic name/logo link previews disclose no product data. Infrastructure follows the selected budget/replicated profile; do not assume BI-06 has been answered.

## Screen/action inventory

Prototype symbols locate the interaction reference; see `prototype-map.md`. Each listed screen needs loading, empty, invalid input, denied permission, network failure, success and applicable version-conflict states. Public restricted screens must show the age boundary instead of restricted content before verification.

| ID / area                | Store screens/actions                                                               | Admin screens/actions                                                         | Rule / roadmap                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| REQ-01 Age               | Entry accept/reject, restricted page, safe return URL, second checkout confirmation | Controlled policy configuration; no separate launch management screen         | Server/API ticket checks, no crawler bypass; 55–57                                   |
| REQ-02 Catalogue         | Shop/product detail, variant selection, specs, up to 8 images, New/Sale/Sold-out    | Products list/editor, variants/SKU/options, draft/publish, trash/restore      | Default variant without options; stock is per combination; 41–54, 58–61              |
| REQ-03 Brands/categories | Navigation, brands page, category/brand filtered listing                            | Lists/editors/order/active toggle, logos, trash/restore                       | Published references valid; preserve historical records; 41–45                       |
| REQ-04 Search            | Search sheet/suggestions, facets, sort, no-result and unavailable states            | Owner search demand/no-result analytics                                       | Bounded terms, stable pagination, measured indexes; 52, 59–60, 104–109               |
| REQ-05 Cart              | Quick-add selector, cart sheet/page, quantities, remove, subtotal preview           | None                                                                          | Persist IDs/quantities; server quote authoritative; unavailable items handled; 62    |
| REQ-06 Promotions        | Apply/remove one eligible percentage code, explain invalid/expired code             | Owner create/edit/activate/expire, usage view                                 | No stacking/fixed/brand scope; locked active counter; 68–72                          |
| REQ-07 Checkout          | Guest name/UAE mobile/area, apartment/villa/office, bounded address/Makani/notes    | Permissioned manual-order wizard                                              | Memory-only PII; quote/key/age required; Dubai validation; 65–82, 89                 |
| REQ-08 Orders            | Private confirmation, expiry/contact/retry states                                   | List/filter/detail/history, edits, transitions, bulk confirm, reasoned cancel | Six states, expected versions, idempotent commands, snapshots; 73–89                 |
| REQ-09 Inventory         | Sold-out visible, per-variant availability                                          | Variant adjustments add/remove/set, reason, threshold and low-stock           | Ledger only; explicit conditional stock writes; 46–51                                |
| REQ-10 Customers         | No login/profile                                                                    | Operational contact/history; Owner spend/export                               | Phone-normalized identity; prior order snapshots immutable; 65, 83, 103, 111         |
| REQ-11 Reviews           | Approved rating/reviews, moderated submission                                       | Owner pending/approve/reject                                                  | Verified proof tied to purchased delivered product; no fake published review; 95–97  |
| REQ-12 Device lists      | Wishlist, compare, recently viewed, empty/deleted-item states                       | Owner anonymous wishlist aggregates                                           | Device-only IDs; no account/PII; 63, 104–109                                         |
| REQ-13 Delivery          | Active Dubai area/ETA, server flat fee                                              | Owner approved areas/fee/settings                                             | Free threshold and progress off until explicitly approved; 38–40, 66, 70             |
| REQ-14 Content           | Ticker, hero, featured/best sellers, brands, campaign/offers                        | Owner seven schema-defined sections, draft/publish                            | No arbitrary page builder; references and version validation; 98–102                 |
| REQ-15 SEO/preview       | Canonical/metadata, generic OG logo, public sitemap only                            | Owner SEO editor/report/redirects                                             | Product metadata protected; richer preview/indexing needs policy decision; 57, 113   |
| REQ-16 Notifications     | None                                                                                | Bell/inbox, own read/unread, SSE reconnect, eligible alerts                   | Immutable content + per-recipient receipts; email does not gate order; 25, 78, 91–94 |
| REQ-17 WhatsApp          | Support, cart/product/order context links                                           | Order-contact links and manual status template                                | Opening wa.me is not verified delivery/confirmation; no API send integration; 64, 90 |
| REQ-18 Analytics/reports | Minimal bounded anonymous events                                                    | Owner metrics, five CSV types, private report jobs                            | Booked/delivered/collected distinct, Dubai dates, sanitized CSV; 104–112             |
| REQ-19 Identity          | No customer auth                                                                    | Login/logout, me, invite/reset, staff active state, Owner/Staff               | Host-only admin session, Origin/CSRF, last-Owner common guard; 27–40                 |

## Commerce commands and field rules

- Status values: pending, confirmed, processing, out_for_delivery, delivered, cancelled. Delivered never means collected.
- Pending/Confirmed: items/address/coupon edits recalculate totals and inventory/coupon deltas in one transaction. Processing permits notes/operational metadata only.
- Cancellation before handoff releases stock and coupon once. Post-handoff cancellation is Owner-only after goods are physically received/classified; restore only resellable units. Delivered cancellation is forbidden at launch.
- Collection is an explicit authorized amount/time/actor command, available independently of delivery; corrections are Owner-only with reason/audit. Do not mutate payment/status via general PATCH.
- Quotes use current variant/product prices, integer fils, approved tax basis and versions. Price/config change requires a new explicit acceptance.
- Order creation atomically commits snapshots, stock/ledger, coupon usage, history, PostgreSQL idempotency response and required outbox/effects. No Redis/email/network operation inside that transaction.
- Cookie confirmation lasts initially 30 minutes; no token in JSON, URL, device storage or telemetry. Expired replay cannot create another order.
- All mutable aggregates use expected versions; stale writes show 409/reload state. Normalize phone/SKU/coupon identifiers and constrain pagination/sort/quantities.

## Permission matrix

| Capability                                                                  | Owner                     | Staff                  |
| --------------------------------------------------------------------------- | ------------------------- | ---------------------- |
| Orders read/manual create/edit/normal transitions/pre-dispatch cancellation | Yes                       | Yes                    |
| Explicit COD collection                                                     | Yes                       | Yes                    |
| Post-handoff return cancellation/collection correction                      | Yes                       | No                     |
| Catalogue/variants/brands/categories publish/trash/restore                  | Yes                       | Yes                    |
| Inventory read/reasoned adjustment                                          | Yes                       | Yes                    |
| Customer operational contact/history                                        | Yes                       | Yes                    |
| Customer lifetime spend/export                                              | Yes                       | No                     |
| Permanent catalogue purge/SEO/redirects                                     | Yes, historical FK checks | No                     |
| Revenue/analytics/reports/exports                                           | Yes                       | No                     |
| Reviews/coupons/content/settings/delivery/staff/roles                       | Yes                       | No                     |
| Notifications                                                               | Own eligible alerts       | Own operational alerts |

API guards enforce actions; services filter fields/object scope. Hiding a button is insufficient. Last-Owner membership changes lock the seeded Owner-role row before sorted staff rows under Read Committed. No wildcard Staff grant.

## Cross-cutting states and dependencies

- Server failure or uncertain checkout outcome: preserve attempt key and retry the same payload/key; clear cart only after acknowledged success.
- Queue outage: accepted DB work remains durable; legitimate bounded checkout may commit. Authoritative DB/age/auth failure rejects safely.
- Budget: bounded API LRU/local limiter, no second Redis. Replicated: separate cache Redis with bounded local checkout fallback; auth limiter follows strict policy.
- Age-protected HTML/RSC/API/media/metadata responses remain private/no-store; generic preview is a separate public surface. No product disclosure through warm CDN responses.
- Email/media/report work uses durable effects, leases/reconciliation, finite retries and an investigation path; no exactly-once email promise.
- Real catalogue, legal/tax inputs, approved assets, provider/profile, recipients/retention and first Owner come from the client; prototypes are not release fixtures.

## Traceability

Requirements above map to the existing 132-step roadmap; scenario IDs in `acceptance.md` define evidence. `implementation-status.md` records actual completion. Add PR/test/release evidence to each requirement when implemented; do not mark a roadmap gate passed from documentation alone.
