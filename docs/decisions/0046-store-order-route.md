# 0046 — Store order submission route, limits and outage behaviour

- Date: 2026-10-13
- Status: accepted
- Step(s): 77 (notifications: 78; confirmation cookie: 79; checkout form: 80; correctness gate: 82)

## Context

Roadmap step 77: the store route that places an order, with its limiter and a bounded answer when a dependency is down. Architecture §7 (checkout) and §11 "Rate-limit and dependency outage policy". `CreateOrderService.place` (ADR 0045) already does everything about the order itself in one transaction. Two items were deferred to this step: the stricter limit on wrong coupon codes (step 71 review) and the scheduled cleanup of idempotency answers (ADR 0043).

## Decision

**`POST /v1/store/orders`** (`StoreOrdersController`). The body is `storeOrderRequestSchema`: `contact`, `address`, `lines`, `couponCode`, `quoteToken` and `ageConfirmed`, built from the shared checkout schemas (ADR 0035). Unknown fields are refused, so there is no way to send a price, fee or total. `ageConfirmed` must be the literal `true`: this is the second 18+ confirmation. The attempt key travels in the `Idempotency-Key` header (22–128 URL-safe characters). The answer is `201` with `orderNumber`, `totalFils` and `placedAt`, and is the same on a retry. It is `private, no-store` and sets no cookie (the confirmation cookie is step 79).

**Order of checks.** Global Origin and content-type check → age ticket (`@AgeVerified()`) → body contract → submission switch → attempt key → attempt limit → coupon-guess limit → `CreateOrderService.place`. The controller holds no order rule and makes no network call around the transaction; the only network dependency of the route is the shared limiter, which is consulted before the transaction starts and has its own 500 ms bound.

**Submission switch.** `CHECKOUT_SUBMISSION_ENABLED` (API, default `false`). While off, a valid, age-verified request answers `503 SERVICE_UNAVAILABLE` and nothing is written. It is switched on per environment once the checkout gate (step 82) has passed; notifications (step 78) must be wired before it is switched on in production.

**Errors.** One stable code each, in the standard envelope:

| Case                                                | Status                 | Code                                                                                                                                    |
| --------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid body or attempt key                         | 400                    | `VALIDATION_ERROR`, `fields` hold paths (`contact.phone`, `idempotencyKey`) and the fixed text `Invalid field`; nothing typed is echoed |
| No age ticket                                       | 403                    | `AGE_VERIFICATION_REQUIRED`                                                                                                             |
| Total changed / acceptance too old / token not ours | 409                    | `QUOTE_CHANGED`, `QUOTE_EXPIRED`                                                                                                        |
| Stock, variant, area                                | 409                    | `INSUFFICIENT_STOCK`, `VARIANT_UNAVAILABLE`, `AREA_UNAVAILABLE` (no variant ID)                                                         |
| Coupon                                              | 409                    | `COUPON_INVALID`, `COUPON_LIMIT_REACHED` (never the reason)                                                                             |
| Key reused with another request                     | 409                    | `IDEMPOTENCY_CONFLICT`                                                                                                                  |
| Same key still running                              | 409 + `Retry-After: 1` | `IDEMPOTENCY_IN_PROGRESS`                                                                                                               |
| Key's answer no longer kept                         | 409                    | `CHECKOUT_RECOVERY_REQUIRED` (neither the order ID nor its number)                                                                      |
| Lock contention exhausted                           | 503 + `Retry-After: 1` | `TRANSACTION_RETRY_EXHAUSTED`                                                                                                           |
| Over a limit                                        | 429 + `Retry-After`    | `RATE_LIMITED`                                                                                                                          |
| Submission off                                      | 503                    | `SERVICE_UNAVAILABLE`                                                                                                                   |

The storefront shows its own messages by running the same schemas; the API never returns the typed values.

**Attempt limit.** `checkoutPolicy`: 10 a minute per client address and 5 a minute per normalized phone, counted for every attempt that reaches the limiter, refused ones and retries included. Quotes keep their separate budget.

**Coupon-guess limit.** `couponFailurePolicy`: 10 refused codes per 10 minutes per client address, one budget across the quote route and the order route. Any coupon refusal uses it, `COUPON_LIMIT_REACHED` included, because that answer confirms a code exists. Once the budget is spent, any request from that address that carries a code is refused with `429` before the code is looked at, so a right code cannot be told from a wrong one; requests without a code are unaffected. To refuse before counting, the limiter gained `peek` (`RateLimiter.peek`, `EndpointLimiter.peek`, `RateLimitService.assertOpen`/`record`). The budget is soft: requests sent at the same moment all pass the check before any refusal is counted, so one burst can exceed ten. The overshoot is bounded by the per-minute address limits of the two routes (30 quotes, 10 order attempts). A lost count (limiter error while recording) is logged and does not change the answer.

**Limits come before the replay.** The limiters run before the idempotency lookup, so a retry of a placed order can get `429` instead of its stored answer while a budget is spent (a minute for attempts; up to ten minutes if the request carries a code and the address used up its code budget). No second order results as long as the client retries with the same key: the checkout form (step 80) must keep the key on `429` and say "try again shortly". Anyone who knows a phone number can use up that number's five attempts a minute; the address rule is checked first, so a refused address creates no phone keys.

**Outage behaviour.**

- Shared limiter (replicated profile) unreachable: both policies fall back to bounded local budgets (5 per address and 2 per phone a minute, 60 a minute per process, divided by `RATE_LIMIT_MAX_REPLICAS`; 5 wrong codes per 10 minutes). Orders are still taken; nothing becomes unlimited. The degraded state is logged without key material.
- Queue Redis down: the route never talks to it. The order and its `order.created` event commit in PostgreSQL and the relay delivers later.
- PostgreSQL or the age key unavailable: the request fails; no fallback bypasses them.
- Lock contention or a concurrent attempt with the same key: bounded waits (ADR 0043, `withTransaction`), then a retryable answer.

**No area pre-check.** The earlier note to pre-check the area with `readDeliverableArea` before the transaction is not followed: a retry of an order that was already placed must get its stored answer even if the area was switched off since. The transaction decides (`lockDeliverySelection`), and a replay returns before it.

**Cleanup.** The worker runs `idempotency.cleanup` hourly: `deleteExpiredIdempotencyRecords` in batches of 1000, at most 50 batches a run. The order keeps its own key hash, so a cleaned-up key is answered `CHECKOUT_RECOVERY_REQUIRED` and never makes a second order.

## Consequences

- A shopper who has ten codes refused in ten minutes cannot use any code from that address until the window ends; they can still order without one.
- A request with an invalid body is refused before the limiters and is not counted. It costs one schema parse and no database work.
- With the switch off, an invalid body answers 400 and a valid one 503.
- Limit values are starting points (architecture §11), to be checked in staging (M11).
- Shoppers behind one shared address share the per-address budgets.

## Not built here

- Notifications and email for a new order (step 78), the confirmation cookie and page (steps 79, 81), the checkout form and its stored attempt key (step 80). The storefront Checkout button stays disabled.
