# Iqos Haven — প্রথম coding থেকে production release পর্যন্ত implementation order

**তারিখ:** 6 October 2026  
**Source of truth:** Iqos-Haven-Production-Architecture.md, Revision 2  
**উদ্দেশ্য:** একজন senior engineer এই architecture implement করতে কোন কাজের পরে কোন কাজ করবেন—তার পূর্ণ ordered backlog।

এটি coding execution plan; final architecture-এর scope বা permission matrix পরিবর্তন করে না। নিচের **১৩২টি step** dependency অনুযায়ী সাজানো। Controller/class names প্রস্তাবিত implementation names; business rules, endpoint surfaces এবং trust boundaries architecture অনুযায়ী থাকবে।

আগেই সম্পন্ন কাজ—যেমন architecture/prototype approval—পুনরায় শুরু করার প্রয়োজন নেই। প্রথম পাঁচটি step হলো repository-তে approved references, remaining inputs এবং executable backlog সংগঠিত করা। এখানে দেওয়া controller boundaries ও task numbering প্রকল্পের proposed execution plan; এগুলো কোনো universal senior-engineer checklist নয়।

একটি feature বাস্তবায়নের সাধারণ ক্রম: প্রয়োজনীয় migration/constraint → request/response contract → domain/application service → repository/transaction → controller/guard → UI → প্রয়োজনীয় integration/E2E verification। একটি controller বানানো মানেই feature সম্পূর্ণ নয়। Controller HTTP request নেয়, service business rule চালায়, repository database access করে। Worker handler এবং pure pricing/state-machine code-এর controller লাগে না।

এটি sequential reference order। দল চাইলে independent UI/design-token বা bounded module task পাশাপাশি করতে পারে, কিন্তু dependency/gate এড়িয়ে পরবর্তী feature live করবে না। Logs, security, CI এবং tests শুরু থেকেই থাকবে; শেষ milestone-এ এগুলোর release evidence একত্রে যাচাই হবে।

## Milestone 0 — Coding-ready requirements ও কাজের সীমানা

**আগে দরকার:** অনুমোদিত architecture ও দুটি prototype। Client input সংগ্রহ এবং স্বাধীন foundation কাজ একসঙ্গে চলতে পারে। Tax/delivery/pricing সিদ্ধান্ত ছাড়া সংশ্লিষ্ট rule final বা release হবে না।

| Step | প্রথমে কী বানাবে/প্রস্তুত করবে                                                                 | Component / output                       | শেষ হওয়ার শর্ত                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Approved architecture, storefront/admin prototypes এবং assets এক project reference set-এ রাখবে | `docs/architecture.md`, reference assets | Implementation-এর এক source of truth; prototype demo behavior production requirement হিসেবে ভুলভাবে নেওয়া হচ্ছে না            |
| 2    | Prototype screen/action inventory এবং 19 functional area-র checklist                           | `docs/requirements.md`                   | প্রতিটি screen, action, empty/error/loading state mapped                                                                      |
| 3    | Pending business inputs-এর register                                                            | `docs/business-inputs.md`                | Brand/domain, VAT/excise, delivery/areas, age, preview/indexing, provider/profile, retention ও recipients-এর owner/status আছে |
| 4    | Feature acceptance criteria ও failure scenarios                                                | `docs/acceptance.md`                     | Last-unit race, duplicate checkout, cancel twice, staff denial, Redis outage ও gate bypass-এর expected result লেখা            |
| 5    | Task backlog, dependency order ও capacity estimate                                             | Project backlog / milestones             | Task-level schedule আছে; 14–18 weeks provisional; release criteria আলাদা                                                      |

**Gate:** developer বুঝতে পারে কোন behavior implement করতে হবে, কোনটা client input-এর অপেক্ষায় এবং কোনটা launch scope-এর বাইরে।

## Milestone 1 — Repository ও runnable foundation

**Dependency:** Steps 1–5; independent foundation কাজ শুরু করতে সব business input complete হওয়া লাগবে না।

| Step | কী বানাবে                                                                         | Component / output                                      | শেষ হওয়ার শর্ত                                                                                                     |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 6    | Git repository, branch/review conventions, architecture decisions                 | Repo, `docs/decisions/`                                 | Changes reviewable; secrets/customer data repository-তে নেই                                                        |
| 7    | pnpm/Turborepo workspace এবং strict TypeScript configuration                      | Root workspace/config                                   | Apps/packages এক lockfile ও নির্দিষ্ট supported dependency versions ব্যবহার করে                                    |
| 8    | Storefront, Admin, API এবং Worker-এর minimal bootable app                         | Four `apps/*`                                           | চারটি app আলাদাভাবে start/build হয়; business feature এখনো placeholder                                              |
| 9    | Shared contracts, domain, application, DB, config, logger, tokens এবং UI packages | `packages/*`                                            | Import boundaries এবং dependency direction নির্দিষ্ট                                                               |
| 10   | Local infrastructure                                                              | Docker Compose: PostgreSQL, queue Redis, MinIO, Mailpit | Repeatable startup; queue/cache profile পৃথক; budget profile-এ দ্বিতীয় Redis প্রয়োজন নেই                           |
| 11   | Validated environment configuration ও secret separation                           | Config schemas, `.env.example`                          | Missing/invalid config startup-এ ধরা পড়ে; dev/staging/prod credentials আলাদা                                       |
| 12   | API bootstrap, health, liveness/readiness, graceful shutdown                      | `HealthController`, bootstrap                           | Database/worker connectivity-এর অবস্থা স্পষ্ট; production internals public নয়                                      |
| 13   | Request validation, error envelope, request ID, redacted structured logs          | Pipes, filters, logger                                  | Unknown fields rejected; raw SQL, stack trace, Cookie বা PII log নয়                                                |
| 14   | Database client, migration runner, transaction-context interface                  | `packages/db`, repository base                          | Runtime/migration credentials separated; application services একই transaction context পায়                          |
| 15   | Unit এবং real-PostgreSQL integration harness; staging fixtures                    | Test setup                                              | Tests isolated/resettable; demo seed production-এ চলবে না                                                          |
| 16   | CI pipeline এবং প্রথম staging skeleton                                            | CI, build images, staging deployment                    | Lint/typecheck/test/build automated; দুই front end এবং API staging-এ reachable                                     |
| 17   | Prototype design tokens, fonts, low-level components এবং responsive shells        | Store/Admin layouts, `ui-core`                          | Buttons/forms/dialogs/table/loading/error components usable; age boundary enforce করার আগে product data exposed নয় |

**Gate:** নতুন checkout থেকে reproducibly project চালানো যায়; চার app, local state, migration ও CI কাজ করে।

## Milestone 2 — Shared reliability, communication ও audit foundation

**Dependency:** Steps 6–17। Media, reset/invite email এবং checkout এই foundation ব্যবহার করবে। Framework প্রথমে, business-specific handlers পরে।

| Step | কী বানাবে                                                       | Component / output                                 | শেষ হওয়ার শর্ত                                                                                              |
| ---- | --------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 18   | Audit storage ও append-only audit writer                        | `audit_log`, `AuditService`                        | Actor/action/request ID এবং redacted diff লেখা যায়; public edit/delete নেই                                  |
| 19   | Generic outbox/effect schema ও event contracts                  | `outbox_events`, `consumer_effects`                | Stable event IDs, schema version, required consumers এবং unique effect keys                                 |
| 20   | Atomic event/effect writer                                      | `OutboxService`                                    | Business mutation-এর transaction-এই event/effects লিখতে পারে                                                |
| 21   | Queue connection ও standalone worker lifecycle                  | BullMQ infrastructure                              | Queue Redis `noeviction`; bounded concurrency, clean shutdown; cache eviction policy মিশছে না               |
| 22   | Leased outbox relay                                             | `OutboxRelay`                                      | Short leases, `SKIP LOCKED`, stable job IDs; network call-এর সময় DB transaction ধরে রাখে না                 |
| 23   | Consumer execution, deduplication, lease/heartbeat এবং retries  | `EffectRunner`                                     | Duplicate jobs safe; database effect এবং completion একই transaction-এ                                       |
| 24   | Reconciler, dead-effect inspection/replay এবং durable schedules | `EffectReconciler`, `scheduled_runs`, scheduler    | Redis loss-এর পরে unfinished work পাওয়া যায়; missed schedule slot catch-up হয়                               |
| 25   | Email adapter ও template pipeline                               | `EmailAdapter`, `EmailConsumer`; Mailpit initially | Stable delivery key, provider receipt, retry এবং duplicate-risk policy; external sends default-off in tests |
| 26   | Object-storage adapter ও private service-auth framework         | Storage service, internal authentication           | Quarantine/private/report buckets accessible only through approved service credentials                      |

**Gate:** একটি synthetic transaction event লিখে worker process করতে পারে; duplicate delivery ও Redis job loss থেকে recovery demonstrated। Tests কোনও real customer-কে email পাঠায় না।

## Milestone 3 — Identity, permissions, admin access ও basic settings

**Dependency:** Database, audit, email এবং service-auth foundation। Business contact/area settings পরবর্তী pricing-এর আগে থাকবে।

| Step | কী বানাবে                                                         | Component / output                                                    | শেষ হওয়ার শর্ত                                                                                               |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 27   | Identity migrations এবং explicit permission seeds                 | `staff_users`, `roles`, `permissions`, `role_permissions`, `sessions` | Owner/Staff matrix architecture-এর সঙ্গে মেলে; wildcard overgrant নেই                                        |
| 28   | One-time first-Owner bootstrap ও password hashing                 | Bootstrap command, identity service                                   | Prototype/default password নেই; bootstrap পুনরায় unauthorized Owner তৈরি করে না                              |
| 29   | Admin/storefront same-origin gateway ও origin routing             | Gateway/reverse proxy config                                          | Nest private; routes/cookies/streaming ঠিকমতো forward হয়; browser-added trust headers stripped               |
| 30   | Login/logout/me এবং session lifecycle                             | `AuthController`, `SessionService`                                    | Admin-origin `__Host-ih_admin`; hashed tokens; idle/absolute expiry ও revoke                                 |
| 31   | Authentication guard, permission guard ও response field filtering | Guards/policies/serializers                                           | UI লুকানো ছাড়াও API Staff-কে Owner-only action/field থেকে আটকায়                                              |
| 32   | Origin/CSRF controls এবং endpoint-specific limiter framework      | Security middleware, limiter services                                 | Budget local policy ও replicated shared policy configurable; auth failures unrestricted নয়                   |
| 33   | Password-reset request/consume flow                               | `password_reset_tokens`, `PasswordResetController`                    | Generic account response; single-use 30-minute token; concurrent reuse rejected; sessions revoked            |
| 34   | Staff invite ও acceptance                                         | `staff_invitation_tokens`, invitation endpoints                       | Server-approved role; hashed expiring/revocable token; worker email local/staging-safe                       |
| 35   | Staff list/edit/deactivate এবং session revocation                 | `StaffController`                                                     | Owner-only management; deactivated user next request-এ denied                                                |
| 36   | Last-Owner common guard এবং fixed-role administration             | Identity transaction service                                          | Owner-role row lock; concurrent deactivation/demotion last Owner সরাতে পারে না; custom-role builder deferred |
| 37   | Admin login/reset/invite pages, session-aware layout ও navigation | Admin UI                                                              | Server-denied permissions UI-তেও reflected; expired session recovery works                                   |
| 38   | Store/contact/notification/WhatsApp settings schema ও API         | `settings`, `SettingsController`                                      | Owner-only updates, validation, versions ও audit; no hard-coded brand/contact                                |
| 39   | Delivery areas ও flat-fee/ETA configuration                       | `delivery_areas`, `DeliveryAreasController`                           | Approved Dubai areas; free threshold off by default; inactive area cannot be selected                        |
| 40   | Settings/staff/areas admin forms এবং auth/RBAC acceptance pass    | Admin settings/staff UI                                               | Login through actual admin origin, reset/invite, deactivation, field denial ও last-Owner tests pass          |

**Gate:** Admin এবং Staff বাস্তব session দিয়ে কাজ করতে পারে; permission matrix backend ও UI-তে consistent।

## Milestone 4 — Catalogue, variants, safe media ও inventory

**Dependency:** Identity/RBAC, settings, worker/storage/audit। Start with a real small catalogue slice; full product UI পরে সেই data ব্যবহার করবে।

| Step | কী বানাবে                                                 | Component / output                                                                                    | শেষ হওয়ার শর্ত                                                                                                               |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 41   | Catalogue schema ও query constraints                      | `brands`, `categories`, `products`, `product_options`, `variants`, `product_images`, `slug_redirects` | Unique SKU/slug/option signature, money bounds, versions, safe FK behavior                                                   |
| 42   | Brands CRUD, ordering, active/trash/restore               | `BrandsController`, Brand admin UI                                                                    | Reference-aware deletion; required permission/field restrictions                                                             |
| 43   | Categories CRUD, ordering, active/trash/restore           | `CategoriesController`, Category admin UI                                                             | Published-product references safe; stable slugs                                                                              |
| 44   | Product create/edit/detail/list এবং typed specs           | `AdminProductsController`, Product service/UI                                                         | Draft/published, brand/category/type/puffs, price/tax-treatment references; stale edits conflict                             |
| 45   | Real option combinations ও SKU management                 | `VariantsController`, Variant editor                                                                  | Flavour/nicotine/colour combinations from launch; no-option product only has default variant                                 |
| 46   | Initial stock ledger এবং read/adjust service              | `stock_movements`, `InventoryController`                                                              | Nonnegative stock; INITIAL_STOCK/RESTOCK/MANUAL/DAMAGE movements; direct unchecked stock writes prohibited                   |
| 47   | Admin add/remove/set stock ও optimistic conflicts         | Inventory UI/service                                                                                  | Expected version + reason; set-stock locks current row and writes correct delta                                              |
| 48   | Authenticated quarantine upload authorization             | `media_assets`, `MediaController`                                                                     | Private upload keys, real size policy/limits; incomplete uploads not published                                               |
| 49   | Image validation, Sharp derivatives ও cleanup             | `MediaConsumer`                                                                                       | MIME magic/dimensions/bytes validated; metadata stripped; eight-image limit; bad images rejected                             |
| 50   | Product images gallery/editor                             | Product-media UI/API                                                                                  | Primary/sort/alt, upload processing state and failure recovery; only sanitized derivatives public                            |
| 51   | Publication, trash/restore এবং reference-aware hard purge | Product/catalog services                                                                              | Staff may permitted publish/trash/restore; Owner-only purge; history never cascade-deleted                                   |
| 52   | Catalogue cache owner ও publish invalidation effect       | Budget API LRU; internal invalidation                                                                 | TTL/memory bounded; worker retries; storefront has no second persistent cache; replicated profile uses separate shared cache |
| 53   | Variant low-stock transitions ও durable events            | Inventory domain/events                                                                               | Above→at/below emits once; re-arm after restock; zero does not unpublish                                                     |
| 54   | Catalogue/inventory complete acceptance pass              | Integration + admin journeys                                                                          | SKU conflicts, option sold-out, concurrent adjustments, safe purge/upload and cache propagation tested                       |

**Gate:** Admin থেকে actual variant product তৈরি, image process, stock set ও publish করা যায়।

## Milestone 5 — Age boundary ও complete storefront browsing

**Dependency:** Published catalogue, media, cache, gateway এবং signing-key provisioning। Protected store endpoints age enforcement ছাড়া exposed হবে না।

| Step | কী বানাবে                                                           | Component / output                    | শেষ হওয়ার শর্ত                                                                                                |
| ---- | ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 55   | Age-ticket signer/verifier ও key ring                               | Signing service, API `AgeGuard`       | Private key storefront only; public verification keys; fixed algorithm/kid/audience/expiry                    |
| 56   | Accept/reject routes, routing gate এবং restricted page              | Storefront route handlers, `proxy.ts` | HttpOnly signed age cookie; safe return URL; rejection clears acceptance; server/API checks both              |
| 57   | Generic store preview ও public policy pages                         | Metadata/public routes                | Unverified product request contains no product name/image/price/JSON-LD; no UA bypass                         |
| 58   | Gated catalogue read APIs                                           | `StoreCatalogController`              | Published/active/nondeleted data only; private/no-store responses; query input bounded                        |
| 59   | Product list, category ও brand pages                                | Storefront pages/components           | Responsive, pagination, badges, loading/empty/error states; cached data never bypasses gate                   |
| 60   | Search, suggestions, facets এবং sort                                | `StoreSearchController`, Search UI    | FTS/trigram, allowed sort fields, correct counts; no-result behavior; no unchecked SQL identifiers            |
| 61   | Product detail, option selector, gallery ও safe quick add           | Product page/UI                       | Stock/price is variant-specific; required choice never silently substituted                                   |
| 62   | Device cart এবং quantity/availability UI                            | Cart state/UI                         | Variant IDs persist; server quote authoritative later; deleted/unavailable items handled                      |
| 63   | Wishlist, compare ও recently viewed                                 | Device state/UI                       | No account or customer profile; no checkout PII persistence                                                   |
| 64   | Navigation/home shell/WhatsApp links এবং gate browsing verification | Storefront shell/help UI              | Actual content sections later; public contact copy approved; direct API/RSC and warm-cache gate bypass tested |

**Gate:** Age acceptance-এর পরে বাস্তব products browse/select/cart করা যায়; আগে restricted product data পাওয়া যায় না।

## Milestone 6 — Customers, pricing, coupons ও server quote

**Dependency:** Catalogue, stock, settings/areas, age guard এবং approved tax/delivery policy inputs।

| Step | কী বানাবে                                                        | Component / output                                  | শেষ হওয়ার শর্ত                                                                                    |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 65   | Guest customer/address schema ও normalized identity              | `customers`, `customer_addresses`, Customer service | Phone normalization/uniqueness; no customer login; old snapshots independent                      |
| 66   | Address, phone, Dubai-area ও quantity validation                 | Shared contracts/validators                         | Apartment/villa/office, Makani/notes bounded; inactive area rejected                              |
| 67   | Integer pricing, VAT/approved excise basis ও rounding allocation | `PricingService`, pure domain functions             | No floats/client prices; accountant-approved examples; no assumed double excise                   |
| 68   | Percentage-coupon schema, eligibility ও usage policy             | `coupons`, `coupon_redemptions`, promotion service  | One code/no stacking; expiry/minimum; locked usage counter/release rules                          |
| 69   | Owner coupon CRUD ও discount admin screen                        | `AdminCouponsController`, UI                        | Percentage only, versions/audit, active/expiry/limit checks                                       |
| 70   | Delivery fee calculation ও quote assembly                        | Delivery/pricing application service                | Flat fee; free threshold stays off unless approved; tax/config references captured                |
| 71   | Signed server quote API ও client price acceptance                | `CartQuoteController`, Cart/Checkout pricing UI     | Quote fingerprint/expiry; changed price/config requires explicit new acceptance                   |
| 72   | Pricing/promotion acceptance pass                                | Domain + database tests                             | Half-up rounding/allocation, coupon expiry/limits, address/area changes and tax formulas verified |

**Gate:** একটি cart-এর trustworthy server quote আছে। Stock এখনো cart-এর জন্য reserve হয় না।

## Milestone 7 — Transactional checkout ও first complete order

**Dependency:** Price quote, customer validation, inventory ledger, outbox/effects ও privacy-safe confirmation transport।

Steps 73–81-এর checkout code staging/feature flag-এর পেছনে তৈরি হবে। Required notification/effect migrations ও handlers, confirmation cookie এবং concurrency tests complete না হওয়া পর্যন্ত real customer order submission চালু হবে না।

| Step | কী বানাবে                                                       | Component / output                                                 | শেষ হওয়ার শর্ত                                                                                                                                                                   |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 73   | Order/item/history schema ও display number                      | `orders`, `order_items`, `order_status_history`                    | Immutable customer/item/price/tax/address snapshots; six states; unique order number                                                                                             |
| 74   | Database idempotency claim/replay framework                     | `idempotency_records`, `IdempotencyService`                        | Scope/key/hash unique; same payload replay, changed payload conflict; rollback then winner lookup                                                                                |
| 75   | Canonical lock-order transaction helpers                        | Application/repositories                                           | Read Committed; customer→settings/area→catalogue→coupon→variants after existing order when applicable; deterministic order                                                       |
| 76   | Atomic order-creation application service                       | `CreateOrderService`                                               | Stock, coupon, order, snapshots, history, response and required outbox/effects commit together                                                                                   |
| 77   | Store order submission controller এবং checkout limiter/fallback | `StoreOrdersController`                                            | Quote/age/Origin/contracts; no network calls in DB transaction; bounded outage behavior                                                                                          |
| 78   | First new-order database notification/email handlers            | `notifications`, `notification_receipts`, `OrderCreated` consumers | Order accepted without email dependency; handlers/recipient receipts wired before real checkout is enabled                                                                       |
| 79   | Confirmation cookie/API ও replay expiry handling                | `OrderConfirmationController`                                      | `__Host-ih_order`; no token URL/JSON; valid-cookie replay; expired access never makes another order                                                                              |
| 80   | Checkout form ও durable attempt-key UI                          | Checkout page/state                                                | Name/phone/address memory only; prototype `store.set("co", state.co)` বাদ ও legacy `co` cleanup; attempt key survives refresh; second 18+ confirmation; uncertain response retry |
| 81   | Confirmation page ও cart success handling                       | Confirmation UI                                                    | Cart clears only after acknowledged order; sanitized display; no third-party session replay                                                                                      |
| 82   | Checkout correctness gate                                       | Real DB concurrency + E2E                                          | Last unit, last coupon use, duplicate lines, simultaneous same-key, changed payload, lost response, rollback, limiter/queue outage tested                                        |

**Gate:** Age→product→variant→cart→quote→COD order→private confirmation works with real PostgreSQL and worker effects. Financial correctness is verified before expanding admin convenience features।

## Milestone 8 — Order operations, COD reconciliation ও notification UX

**Dependency:** Real committed orders and staff permissions। Some notification tables/consumers are created at Step 78; this milestone completes their inbox/SSE UI।

| Step | কী বানাবে                                                                | Component / output                                                                           | শেষ হওয়ার শর্ত                                                                                                                    |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 83   | Admin orders list/filter/detail/history APIs ও UI                        | `AdminOrdersController`                                                                      | Status/date/search/page bounds, snapshot data, permissioned customer contact                                                      |
| 84   | Status transition commands ও timeline                                    | `OrderTransitionsController`, State machine/UI                                               | Pending→Confirmed→Processing→Out for Delivery→Delivered; forbidden moves rejected; actor/time/version recorded                    |
| 85   | Pending/Confirmed order edits ও diff display                             | Order edit service/UI                                                                        | Item/coupon/address delta transaction; no stock double-release; Processing limited edits                                          |
| 86   | Pre-handoff cancel ও Owner post-handoff return cancellation              | `OrderCancellationController`, UI                                                            | Reason/command ID; one release; only received resellable quantity restored; Delivered cancellation forbidden                      |
| 87   | Explicit COD collection এবং Owner correction                             | `OrderCollectionController`, UI                                                              | Delivered does not auto-collect; amount/time/actor/reference; correction audit preserves original evidence                        |
| 88   | Manual order wizard                                                      | Manual order endpoint/UI                                                                     | Same quote/inventory/idempotency services; confirmed start requires recorded evidence                                             |
| 89   | Bulk confirm, per-order results এবং retry handling                       | Bulk command endpoint/UI                                                                     | Bounded selection; expected versions; mixed failures shown; no duplicate transition                                               |
| 90   | Customer history/spend views ও order WhatsApp templates                  | `AdminCustomersController`, Customer/order UI                                                | Staff operational fields only; Owner financial summary; `wa.me` never marked as confirmed send                                    |
| 91   | Per-user inbox, read receipts এবং SSE                                    | `notifications`, `notification_receipts`, `NotificationsController`, `AdminEventsController` | Durable inbox; own read flags; reconnect/gap/refetch; no proxy buffering; revocation closes stream                                |
| 92   | Low-stock email/bell, daily-summary registration ও operations acceptance | Stock consumers, scheduler/UI                                                                | Summary actual metrics wired after analytics; no repeated low-stock spam; all order edit/cancel/collection and session tests pass |

**Gate:** Store order থেকে staff fulfillment এবং explicit cash collection পর্যন্ত পুরো operational journey works। Customer CSV later reports milestone-এ।

## Milestone 9 — Reviews, content ও remaining storefront sections

**Dependency:** Eligible delivered orders, catalogue/media, permissions, publishing/invalidation।

| Step | কী বানাবে                                                   | Component / output                   | শেষ হওয়ার শর্ত                                                                                                      |
| ---- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 93   | Review schema ও verified-purchase proof issuance/validation | `reviews`, Review service            | Eligible delivered order/product; bounded expiring proof; supplied order ID alone is insufficient                   |
| 94   | Store review submit এবং pending moderation                  | `StoreReviewsController`             | Rating/text/schema/rate limits; proof cannot grant order-data access; abuse does not auto-publish                   |
| 95   | Owner approve/reject এবং public rating aggregates           | `AdminReviewsController`, Review UI  | Pending/approved/rejected; only approved public; verified flag server-derived                                       |
| 96   | Seven content-section schemas ও draft/published storage     | `content_sections`, Content domain   | Ticker, hero, featured, best sellers, brands, campaign banner, offers; schema version/asset refs                    |
| 97   | Content draft save/preview/publish APIs ও editor            | `AdminContentController`, Content UI | Versioned drafts; safe preview; Owner-only; no arbitrary HTML/page builder                                          |
| 98   | Published home/content read API                             | `StoreContentController`             | Draft never public; one assembled content response with valid product/media refs                                    |
| 99   | Home hero, ticker এবং curated product/brand sections        | Home components                      | Prototype tokens/responsiveness; stock/product changes handled; title/image links consistent                        |
| 100  | Offers/campaign/banner এবং published storefront copy        | Offers/home/help pages               | Unsupported demo coupons removed; free-delivery progress hidden while disabled                                      |
| 101  | Publish, SEO-field permission ও slug-redirect correctness   | Catalogue/content application rules  | Slug cycles/chains prevented; canonical resolves current slug; Staff cannot mutate SEO fields                       |
| 102  | Review/content acceptance pass                              | E2E/integration                      | Invalid refs rejected; multiple editor conflict; publish retry/TTL; order-proof abuse; cache/gate behavior verified |

**Gate:** Storefront/admin prototypes-এর content ও review interactions real data দিয়ে কাজ করে। Search indexing remains a separate decision।

## Milestone 10 — Analytics, dashboard, five reports ও final SEO tools

**Dependency:** Commerce lifecycle, collection records, catalogue snapshots এবং durable scheduled jobs। Browsing telemetry is best effort, not guaranteed commerce work।

| Step | কী বানাবে                                                                | Component / output                                                     | শেষ হওয়ার শর্ত                                                                                                              |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 103  | Bounded anonymous browsing event schema/collection                       | `events`, `StoreEventsController`                                      | Search/product view/cart/wishlist types; batch bounds; no phone/address/name                                                |
| 104  | Client event batching ও overload policy                                  | Storefront telemetry                                                   | Sampling/drop permitted; telemetry cannot block checkout; wishlist device-only                                              |
| 105  | Financial metric queries ও definitions                                   | Analytics application services                                         | Booked/delivered/collected separated; date basis/Asia-Dubai/AED/tax labels                                                  |
| 106  | Daily aggregate tables ও idempotent rollups                              | `sales_daily`, `product_sales_daily`, `search_daily`, `wishlist_daily` | Recompute/upsert by day; historical brand snapshots; retry doesn't add twice                                                |
| 107  | Late-edit backfill, today freshness ও daily email data                   | Rollup/backfill/summary consumers                                      | Recent days recomputed; schedule-slot uniqueness; summary recipients permissioned                                           |
| 108  | Operational home dashboard                                               | `AdminDashboardController`, Dashboard UI                               | Pending orders, low stock, alerts; Staff gets only permitted operational data                                               |
| 109  | Owner financial/search/wishlist dashboards                               | `AdminAnalyticsController`, charts/tables                              | AOV/cancellation/status/product/brand/search/no-result/wishlist; no fake demo chart values                                  |
| 110  | Report-job schema ও report request/status service                        | `report_jobs`, `AdminReportsController`                                | Typed parameters; requester permission; small stream versus durable large export                                            |
| 111  | Five CSV generators                                                      | Sales, Orders, Products, Inventory, Customers                          | Snapshot/date basis documented; spreadsheet-formula sanitization; Customer PII audit                                        |
| 112  | Private report storage, signed download ও expiry cleanup                 | `ReportsConsumer`, download endpoint/UI                                | Permission rechecked at download; requester scope; bounded URL lifetime; Staff cannot fetch guessed job                     |
| 113  | Owner SEO editor/issue report, public sitemap and gated product metadata | `AdminSeoController`, Next metadata/sitemap/robots handlers            | End of Operations work; generic previews/base canonical active; product indexing/JSON-LD activation only if policy approved |
| 114  | Dashboard/report/SEO acceptance pass                                     | Integration/E2E                                                        | Correct financial/date definitions, idempotent backfill, field denial, export security and preview tests                    |

**Gate:** Operational dashboards/reports contain correct real data, access is permissioned and SEO UI reflects actual indexing policy।

## Milestone 11 — Full acceptance, production operations ও release

**Dependency:** All launch features complete; approved provider, availability profile and business inputs। Logs/CI/staging/security already exist; this milestone proves the whole system and production recovery।

| Step | কী বানাবে/সম্পূর্ণ করবে                                                       | Component / output                          | শেষ হওয়ার শর্ত                                                                                                                       |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 115  | Full prototype parity review                                                  | Screen/action checklist                     | All 19 areas, mobile states, empty/error/loading/permission states accounted for                                                     |
| 116  | Commerce concurrency regression                                               | Real DB test suite                          | Stock/coupon/edit/cancel/collection/idempotency constraints hold under simultaneous requests                                         |
| 117  | Worker crash/Redis-loss recovery drill                                        | Failure-injection suite                     | Before/after enqueue/provider acceptance/lease expiry; dead-effect replay; safe duplicate effects                                    |
| 118  | Auth/privacy/gate/token/key regression                                        | Security integration tests                  | Owner guard, reset/invite reuse, session revoke/SSE, cookie leakage, key rotation/revocation, no `co` persistence                    |
| 119  | Selected profile cache/limiter/replica verification                           | Budget LRU/shared-cache tests               | TTL/invalidation; checkout limiter fallback; per-instance ceilings; identical build/cache rules for replicas                         |
| 120  | Actual link-preview and browser/mobile accessibility check                    | Staging devices/platforms                   | Generic previews disclose no product data; keyboard/dialog/form errors/mobile sheets usable                                          |
| 121  | Representative load/query/payload testing                                     | Load report, query plans                    | Defined dataset/concurrency; measured API/checkout p95, pool/lock waits; source performance targets evaluated                        |
| 122  | Production IaC, private networking, DNS/TLS/origin controls                   | Terraform/container infrastructure          | Selected UAE profile/provider supported; DB/Redis/private API not public; least privilege                                            |
| 123  | Production secrets and credential lifecycle                                   | Secrets/runbook                             | Separate keys/roles/environments; rotate/revoke process; no prototype credentials                                                    |
| 124  | Approved data import ও production Owner/settings bootstrap                    | Validated import commands                   | Real variants/SKUs/images/tax refs; initial stock ledger; areas/fee/contact; no demo seed                                            |
| 125  | Monitoring, synthetic checks, alerts ও recipient verification                 | Sentry/OTel/logs/alerts                     | PII scrubbed; checkout/effect/DB/queue/cache signals; alert routing works                                                            |
| 126  | Backup configuration ও measured isolated restore                              | Backup/restore drill                        | DB/media/infrastructure recovery; unfinished effects reconciled; external sends disabled during drill; RPO/RTO measured              |
| 127  | Incident, queue recovery, rollback, email, upload and owner recovery runbooks | `docs/runbooks/*`                           | On-call/operator can act; procedures exercised; compromised keys/staff access recoverable                                            |
| 128  | Release migration ও rollback rehearsal                                        | Staging release test                        | Expand/deploy/contract separation; exact digest promotion; compatible app rollback; production credentials isolated                  |
| 129  | Client UAT ও final business gates                                             | Sign-off register                           | Tax/excise, delivery, age, retention, preview/indexing/profile/providers/recipients agreed; blockers resolved                        |
| 130  | Controlled production release                                                 | Deployment pipeline                         | Approved digests/settings; safe migration; health checks; monitored rollout                                                          |
| 131  | Real-environment smoke এবং early operations verification                      | Post-release checklist                      | Authorized test order/fulfillment/cancel/collection path; notifications/storage/backups verified without uncontrolled customer sends |
| 132  | Handover, operating routine ও scheduled maintenance                           | Documentation/training/monitoring ownership | Owner/staff trained; patch/restore schedule; known limitations; daily cash reconciliation responsibility assigned                    |

**Gate:** Client-approved production system, measured recovery, monitored launch and an operator capable of running it। A visually complete website alone is not this gate।

## Controller / route ownership map

Browser prefix is `/api`; Nest controller routes normally start `/v1`. The names below are suggested file/class boundaries, not instructions to add another backend to Next.js. Business rules remain in Nest/shared application services. The age signer and framework metadata handlers are explicit exceptions with tightly limited responsibilities.

| Controller / handler                                    | When built    | Responsibility                                                   |
| ------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `HealthController`                                      | 12            | Liveness/readiness; internal dependency status                   |
| `AuthController`                                        | 30            | Login/logout/me/session transport                                |
| `PasswordResetController`                               | 33            | Forgot/reset commands                                            |
| `StaffController` / invitation endpoints                | 34–36         | Invite, list/update/deactivate, guarded fixed-role assignment    |
| `SettingsController`                                    | 38            | Approved typed Owner settings                                    |
| `DeliveryAreasController`                               | 39            | Dubai area/config administration                                 |
| `BrandsController`                                      | 42            | Brand admin operations                                           |
| `CategoriesController`                                  | 43            | Category admin operations                                        |
| `AdminProductsController`                               | 44, 51        | Product mutations/list/detail/publish/trash/restore; purge guard |
| `VariantsController`                                    | 45            | Option/SKU/variant-price administration                          |
| `InventoryController`                                   | 46–47         | Read/adjust stock with reason, version and ledger                |
| `MediaController`                                       | 48            | Upload authorization/status; no unchecked publication            |
| Private cache invalidation endpoint                     | 52            | Authenticated cache-owner invalidation; no public bypass         |
| Storefront age route handlers                           | 55–56         | Issue/reject age decision; private signer; no commerce logic     |
| API `AgeGuard`                                          | 55–58         | Verify allowed public keys/ticket before catalogue/checkout      |
| `StoreCatalogController`                                | 58            | Gated public catalogue read surface                              |
| `StoreSearchController`                                 | 60            | Gated bounded search/suggestions/facets                          |
| `AdminCouponsController`                                | 69            | Owner percentage coupon administration                           |
| `CartQuoteController`                                   | 71            | Authoritative signed quote                                       |
| `StoreOrdersController`                                 | 77            | Validated idempotent guest order command                         |
| `OrderConfirmationController`                           | 79            | Cookie-authorized minimal confirmation                           |
| `AdminOrdersController`                                 | 83, 85, 88–89 | Operational order reads/edit/manual/bulk commands                |
| `OrderTransitionsController`                            | 84            | State-machine transition commands                                |
| `OrderCancellationController`                           | 86            | Controlled cancellation/stock release                            |
| `OrderCollectionController`                             | 87            | Explicit collection/correction                                   |
| `AdminCustomersController`                              | 90            | Operational customer history; permissioned financial fields      |
| `NotificationsController`                               | 91            | Own inbox/read receipts                                          |
| `AdminEventsController`                                 | 91            | Authenticated same-origin SSE                                    |
| `StoreReviewsController` / `AdminReviewsController`     | 93–95         | Proof-aware submission, moderation and public aggregate reads    |
| `AdminContentController` / `StoreContentController`     | 97–98         | Versioned drafts/publish; public published reads                 |
| `StoreEventsController`                                 | 103           | Bounded best-effort anonymous telemetry                          |
| `AdminDashboardController` / `AdminAnalyticsController` | 108–109       | Permissioned operational and financial views                     |
| `AdminReportsController`                                | 110–112       | Request/status/download/export authorization                     |
| `AdminSeoController` and Next metadata handlers         | 113           | Owner SEO fields/issues; robots/sitemap/metadata policy          |

`PricingService`, stock/coupon transaction rules, order state machine, idempotency claim, outbox relay, reconciler, image/email/report/rollup consumers and scheduler are services/worker handlers. Giving each an HTTP controller is unnecessary. Controller classes may be consolidated within a module while preserving explicit command contracts and permissions.

## Database migration rollout — সব 40 logical table কোথায় আসে

The ERD and constraints are planned early. Feature migrations land before the feature that uses them; do not wait for all UI to finish. Migration rollback/compatibility is checked from the first migration.

| Migration group       | Logical tables                                                                                                            | Steps                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Audit/reliability     | `audit_log`, `outbox_events`, `consumer_effects`, `scheduled_runs`                                                        | 18–24                                              |
| Identity              | `staff_users`, `roles`, `permissions`, `role_permissions`, `sessions`, `password_reset_tokens`, `staff_invitation_tokens` | 27–34                                              |
| Settings/delivery     | `settings`, `delivery_areas`                                                                                              | 38–39                                              |
| Catalogue             | `brands`, `categories`, `products`, `product_options`, `variants`, `product_images`, `slug_redirects`                     | 41                                                 |
| Inventory             | `stock_movements`                                                                                                         | 46                                                 |
| Media                 | `media_assets`                                                                                                            | 48                                                 |
| Customer              | `customers`, `customer_addresses`                                                                                         | 65                                                 |
| Promotions            | `coupons`, `coupon_redemptions`                                                                                           | 68; order linkage completed with order migration   |
| Orders/idempotency    | `orders`, `order_items`, `order_status_history`, `idempotency_records`                                                    | 73–74                                              |
| Notification delivery | `notifications`, `notification_receipts`                                                                                  | 78 before real checkout; inbox/SSE completed at 91 |
| Reviews               | `reviews`                                                                                                                 | 93                                                 |
| Content               | `content_sections`                                                                                                        | 96                                                 |
| Raw analytics         | `events`                                                                                                                  | 103                                                |
| Analytics aggregates  | `sales_daily`, `product_sales_daily`, `search_daily`, `wishlist_daily`                                                    | 106                                                |
| Reports               | `report_jobs`                                                                                                             | 110                                                |

Cross-table foreign keys require the referenced migration first. For example, `coupon_redemptions` can be introduced with the order migration instead of creating a broken FK in Step 68; Step 68 defines its contract and policy. `product_images` asset FK is finalized once `media_assets` exists; staff actor FKs are finalized with the identity migration. Generic outbox/effect aggregate references support identity/media/catalogue events before orders exist. The sequence is an implementation dependency plan, not a demand to create every listed table on the exact same numbered day.

## Every feature-এর completion checklist

A task is reviewable when its allowed behavior, failure behavior and relevant evidence are present:

- Migration/constraints/indexes exist and run on a clean/test database.
- Request/response schema, errors, permission and field scope are explicit.
- Service/repository uses the common transaction context and correct lock order where needed.
- Required audit/outbox/effects are written atomically with the mutation.
- UI uses committed responses; loading/empty/error/conflict/retry states work.
- Relevant unit/integration/E2E checks pass; money/concurrency/security claims use appropriate real checks.
- Logs are useful without PII/tokens; health/metrics are extended where the feature needs them.
- Staging fixture/import/documentation is updated; demo credentials/data are not promoted to production.

Do not add mirrored tests for trivial reversible presentation changes. Concentrate verification on business correctness, access, integration and failure recovery. Every milestone finishes with a staging demonstration of its completed behavior.

## Source scope coverage

| Architecture area                     | Implementation steps           |
| ------------------------------------- | ------------------------------ |
| Age gate                              | 55–57, 64, 118, 120            |
| Catalogue / variants / images         | 41–54, 58–61                   |
| Categories and brands                 | 42–43, 59, 99                  |
| Search/filter/facets                  | 60, 103–106, 109               |
| Cart                                  | 62, 70–72, 80–82               |
| Percentage promotions                 | 67–72, 75–76                   |
| Guest checkout                        | 65–67, 73–82                   |
| Orders / manual / edits / bulk / COD  | 73–89, 116                     |
| Inventory / low stock                 | 46–47, 53–54, 75–76, 85–86, 92 |
| Customers                             | 65–66, 90, 111–112             |
| Reviews                               | 93–95, 102                     |
| Wishlist / compare / recently viewed  | 63, 103–104, 109               |
| Delivery                              | 39–40, 66, 70                  |
| Seven content sections                | 96–102                         |
| SEO / generic previews                | 57, 101, 113–114, 120          |
| Notifications / email / daily summary | 19–25, 53, 78, 91–92, 107      |
| WhatsApp templates and links          | 38, 64, 90                     |
| Analytics / five reports              | 103–114                        |
| Staff/auth/permissions                | 27–40, 118                     |

Launch excludes customer accounts, online payments, WhatsApp Business API, custom-role builder, MFA, fixed/brand-scoped coupons, multi-emirate delivery and external search unless scope is explicitly revised. Cross-device order confirmation is also deferred. Product indexing remains off unless its policy is approved; basic SEO/generic previews still work as specified.

## একজন senior engineer প্রথম working slice হিসেবে কী দেখাবেন

Foundation-এর প্রথম demonstration: clean checkout → local services → API/worker healthy → admin login → Staff forbidden action denied। এরপর catalogue demonstration: product + real variants + sanitized image + stock ledger → published gated storefront। তারপর commerce demonstration: accepted age → selected variant → quote → atomic order → durable notification → same-key retry returns the same order।

এই তিনটি demonstration backend, UI, permissions ও failure behavior একসঙ্গে যাচাই করে। তারপর order operations, content, analytics এবং release scope বাড়ে। টেস্ট ছাড়াই “সব controller লেখা শেষ” হওয়া milestone নয়।
