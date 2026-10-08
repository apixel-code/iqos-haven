# Acceptance scenarios and release evidence

Derived from approved Architecture Revision 2. **Status: specifications, not passed business tests.** Current automated foundation checks are listed in `verification.md`. Use real PostgreSQL 18 for transactional/concurrency evidence; mocked transactions and SQLite are insufficient. Record commit, environment/profile, data set, test command, observed result and reviewer for each completed gate.

## Foundation regression checks

| ID     | Trigger                                                               | Expected outcome                                                | Current evidence                               |
| ------ | --------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| FND-01 | Domain/application/front end imports DB/framework across boundary     | Lint blocks scoped and relative-path violations                 | `pnpm test:boundaries`                         |
| FND-02 | Logs contain nested/root/array PII, raw URL, cookie or exception text | Sensitive values absent; bounded recursive handling             | logger regression tests                        |
| FND-03 | Idle pool emits error                                                 | Handled, safe diagnostics, no uncaught emitter exception        | db client unit test; live outage drill pending |
| FND-04 | Invalid/unknown API body fields or missing DTO contract               | Reject; consistent code/fields/requestId; no SQL/stack leakage  | HTTP regression tests                          |
| FND-05 | Missing/empty/incomplete migration bundle at staging/production       | Nonzero exit before deploy; empty opt-in only local development | migration-policy tests                         |
| FND-06 | Test URL points to runtime/non-test database                          | Refuse before DDL; unique schema per test run                   | config tests + real DB harness                 |
| FND-07 | Worker receives unknown business job or startup hangs                 | Job fails instead of fake acknowledgement; bounded startup      | lifecycle regression tests                     |
| FND-08 | Invalid production APP_ENV/config                                     | Fail startup without echoing values                             | config tests                                   |
| FND-09 | Open updated prototype after previous checkout                        | Remove legacy co/lastOrder PII; no new browser persistence      | reference checks; click-through pending        |

## Business acceptance specifications

| ID / requirement       | Scenario                                                               | Expected result                                                                        |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CAT-01 / REQ-02        | Product with no options vs multiple option combinations                | One default variant vs exact selectable SKU/signature rows; published valid references |
| CAT-02 / REQ-02        | Inactive/unavailable/deleted variant in cart/quick add                 | Explain unavailable state; never silently choose another flavour                       |
| CAT-03 / REQ-03        | Trash referenced parent or permanent purge                             | Block/reassign transactionally; history preserved; Staff purge denied                  |
| CAT-04 / REQ-02        | Ninth image, double primary, spoofed type or huge dimensions           | Reject/hold in quarantine; only validated derivatives public                           |
| AGE-01 / REQ-01        | Unverified visitor direct HTML/RSC/API/metadata access                 | No product name/image/price/JSON-LD; gate/denial response                              |
| AGE-02 / REQ-01        | Accepted visitor warms CDN, then unverified request                    | No verified response reused; private/no-store boundaries verified                      |
| AGE-03 / REQ-01        | Spoof crawler UA/headers, expired ticket, wrong algorithm/audience/kid | No bypass; reject/re-gate                                                              |
| AGE-04 / REQ-01        | New public key roll-out then signer switch                             | Both allowed public keys verify through old-ticket expiry + skew                       |
| AGE-05 / REQ-01        | Compromised key revoked                                                | Immediate rejection of affected tickets; visitor re-gates                              |
| AGE-06 / REQ-15        | WhatsApp/Facebook preview before age acceptance                        | Generic approved name/logo only; no product disclosure                                 |
| PRICE-01 / REQ-06,13   | Duplicate variant lines, coupon allocation, inclusive/exclusive tax    | Merge quantities, integer half-up calculation, deterministic allocation, no overflow   |
| PRICE-02 / REQ-06      | Two concurrent orders use last coupon redemption                       | One succeeds; locked active count never exceeds limit                                  |
| PRICE-03 / REQ-06      | Coupon expired/minimum/starts/stacking/unsupported type                | Server validation rejects; amount/eligibility not taken from client                    |
| PRICE-04 / REQ-13      | Free threshold off or area inactive                                    | Flat fee per approved policy; no progress bar/free delivery by demo default            |
| PRICE-05 / REQ-07      | Price/tax/area/config changes after quote                              | 409 QUOTE_CHANGED; explicit new acceptance; no silent new total                        |
| PRICE-06 / REQ-07      | Tax-paid goods and approved accountant examples                        | Correct VAT/basis/invoice treatment; no assumed duplicate excise charge                |
| STOCK-01 / REQ-09      | Simultaneous last-unit purchases                                       | At most one committed purchase; nonnegative variant balance                            |
| STOCK-02 / REQ-09      | Edit/add/remove quantities and cancellation twice                      | Correct ledger deltas; no double release; coupon released once                         |
| STOCK-03 / REQ-09      | Concurrent stock-set and order/adjustment                              | Version/locking conflict handled; ledger/balance remain equal                          |
| STOCK-04 / REQ-09      | Returned items partly damaged                                          | Owner restores only physically received resellable units; damage recorded              |
| CHECK-01 / REQ-07      | Same key/hash concurrently or after refresh                            | Same committed order/response; no duplicate stock/effects                              |
| CHECK-02 / REQ-07      | Same key, changed payload                                              | IDEMPOTENCY_CONFLICT; no additional order                                              |
| CHECK-03 / REQ-07      | Commit succeeds, response lost                                         | Same attempt key retry recovers result and valid confirmation cookie                   |
| CHECK-04 / REQ-07      | Transaction fails before/at commit                                     | No partial order/stock/coupon/outbox; approved transient error restarts whole tx       |
| CHECK-05 / REQ-07      | Response replay/cookie expires                                         | Recovery/expired state; retained key linkage never permits duplicate creation          |
| CHECK-06 / REQ-07      | Fake area/phone, extra status/payment field, oversized lines           | Bounded contract rejects; no mass assignment                                           |
| CHECK-07 / REQ-07      | Queue/cache limiter outage                                             | Legitimate bounded checkout works with durable effects; abuse still capped             |
| CHECK-08 / REQ-07      | Authoritative DB/age/auth unavailable                                  | Safe refusal; limiter fallback does not bypass required checks                         |
| CONF-01 / REQ-08       | Order number/phone alone or guessed capability                         | No order disclosure; confirmation scope only                                           |
| CONF-02 / REQ-08       | Lost-response cookie replay and newer checkout                         | Restore cookie only while valid; latest acknowledged order replaces old cookie         |
| CONF-03 / REQ-08       | Inspect URL/JSON/log/analytics/storage                                 | No capability or checkout PII; cookie Secure/HttpOnly/host-only; no-referrer/no-store  |
| ORDER-01 / REQ-08      | Each allowed/forbidden state transition                                | Exact six-state machine, expected version and append-only history                      |
| ORDER-02 / REQ-08      | Processing merchandise edit or Delivered cancellation                  | Reject; notes-only Processing changes; no arbitrary reverse transition                 |
| ORDER-03 / REQ-08      | Mark Delivered with no collection command                              | COD remains uncollected                                                                |
| ORDER-04 / REQ-08      | Collect twice, correction, cancelled order                             | Idempotent explicit collection; forbidden state denied; Owner correction audited       |
| ORDER-05 / REQ-08      | Manual order / bulk confirm / stale form                               | Permissioned evidence; per-order bounded outcomes; 409 reload state                    |
| AUTH-01 / REQ-19       | Real admin-origin login                                                | __Host-ih_admin cookie works through gateway, not storefront domain cookie             |
| AUTH-02 / REQ-19       | Bad Origin/content-type/forged trust header                            | Reject or strip; no public private-API bypass                                          |
| AUTH-03 / REQ-19       | Reset/invite concurrent use or expired/deactivated user                | Single-use atomic consumption; generic account errors; no unauthorized role            |
| AUTH-04 / REQ-19       | Idle/absolute expiry or staff deactivation/SSE                         | Session invalid; stream closes/revalidates                                             |
| AUTH-05 / REQ-19       | Last two Owners concurrently removed/demoted                           | Common Owner-role lock preserves one active Owner                                      |
| RBAC-01 / REQ-10,18,19 | Staff calls Owner routes/requests private fields directly              | Denied; no revenue/lifetime spend/exports/settings/SEO leak                            |
| RBAC-02 / REQ-18       | Staff guesses Owner report ID/download                                 | Recheck current requester/permission; deny; audit authorized exports                   |
| REL-01 / REQ-16        | Worker crash before/after enqueue or Redis loss                        | Durable unfinished effects rediscovered/re-enqueued                                    |
| REL-02 / REQ-16        | Duplicate consumer delivery/job cleanup                                | Unique durable effect prevents duplicate DB side effects                               |
| REL-03 / REQ-16        | Provider acceptance then crash                                         | Stable supported provider key or documented bounded duplicate risk                     |
| REL-04 / REQ-16        | Expired lease/dead effect/scheduled missed slot                        | Recover/catch up once per durable slot; dead is not completed                          |
| NOTIF-01 / REQ-16      | One of two staff reads notification                                    | Only own receipt changes; eligible recipient snapshot respected                        |
| NOTIF-02 / REQ-16      | SSE reconnect/revocation/replica wake-up                               | Durable gap recovery and permission checks; Redis wake-up is only hint                 |
| CONTENT-01 / REQ-14    | Invalid product reference/stale draft/publish                          | Reject or 409; publish versions/audit; propagation within agreed target                |
| SEARCH-01 / REQ-04     | Long term/bad sort/filter/page/zero results                            | Bounded validated query, stable secondary ID order, clear facet semantics              |
| REVIEW-01 / REQ-11     | Fake order ID vs valid review proof                                    | Verified flag only from eligible purchase proof; all submissions moderated             |
| DEVICE-01 / REQ-12     | Device list contains deleted item or refresh                           | Tolerate IDs; no customer profile/checkout PII persisted                               |
| WA-01 / REQ-17         | Staff opens a WhatsApp template                                        | UI records opening only; no automatic sent/confirmed assertion                         |
| REPORT-01 / REQ-18     | CSV with formula prefix and Dubai midnight boundaries                  | Formula-safe text, correct date basis; booked/delivered/collected separate             |
| PRIV-01 / all          | Inspect logs/traces/reports/exports                                    | No unnecessary PII/secrets; recipient scope, retention/anonymization policy            |
| DEPLOY-01 / all        | Missing migration file or incompatible rolling release                 | Release stops; expand/deploy/contract reviewed and compatible rollback rehearsed       |
| RESTORE-01 / all       | Isolated DB/media restore and queue rebuild                            | External sends disabled; measured RPO≤5m/RTO≤1h only if demonstrated                   |
| LOAD-01 / all          | Representative mixed browsing/checkout and outages                     | Record p95, lock/pool waits, data set, capacity/profile; no invented pass label        |
| UI-01 / all            | Mobile/keyboard/dialog/error/dark-theme/long-table journeys            | Approved prototype fidelity and usable accessible states on agreed devices             |

## Staging journeys and sign-off

1. Age → options → cart → server quote → guest COD → lost response retry → private confirmation.
2. Actual admin login → notification → Confirmed → Processing → Out for Delivery → Delivered → explicit collection.
3. Variant adjustment → sold-out/low-stock alert → catalogue publish/invalidation.
4. Staff direct Owner endpoint/field/export denial; independent notification reads.
5. Rejected/unverified shopper stays blocked after caches warm, on every replica.

For every milestone gate attach results rather than checking a box from elapsed weeks. Final UAT also resolves BI-01–BI-11, provider/profile, asset/copy and tax-policy sign-off. No real email/customer data is used in staging unless separately controlled.
