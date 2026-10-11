# 0005 — CSRF by Origin + JSON-only bodies; fixed-window endpoint limiters

- Date: 2026-10-09
- Status: accepted
- Step(s): 32 (used by 33, 34, 75, 76)

## Context

Architecture §11 asks us to validate Origin on every state-changing cookie-authenticated request, use a CSRF token "where the request flow needs it", reject unsupported content types, and rate-limit authentication with an authoritative limiter that fails closed. Checkout and quote must fall back to bounded local limits instead. Admin sessions already use SameSite=Strict `__Host-` cookies, and every browser call is a same-origin JSON `fetch` through the gateway.

## Decision

- **No CSRF token at launch.** A Fastify `onRequest` hook in the API handles every non-GET/HEAD/OPTIONS request, before body parsing, routing or authentication:
  - It requires an `Origin` that belongs to the target surface: `ADMIN_ORIGINS` for `/v1/auth/*` and `/v1/admin/*`, `STOREFRONT_ORIGINS` for `/v1/store/*`.
  - It refuses any request where `Sec-Fetch-Site` is present and is not `same-origin`/`none`.
  - It accepts only `application/json` bodies.
  - Paths are classified after percent-decoding and slash collapsing, as the router sees them. A state-changing request to an unknown surface is refused.
  - Internal HMAC routes skip the Origin and Sec-Fetch-Site rules, but not the JSON-only rule.
  - Login and logout are covered like any other mutation.

  A token is added only if a flow appears that cannot meet these rules, such as a non-JSON upload through the API.

- **Limiters.** `@ih/platform` provides fixed-window counters, local and Redis (Lua `INCR`+`PEXPIRE`), plus an `EndpointLimiter` that takes per-endpoint policies:
  - Limiter keys are HMAC-keyed hashes, purpose-specific per endpoint and dimension.
  - The local limiter caps keys per `endpoint:dimension` partition, so a flood of random emails cannot crowd out client-IP windows. When a partition is full, new keys share one overflow window with the same rule. This is the conservative global ceiling from the architecture: it never evicts live windows and never denies every new caller outright. Expired windows are swept at most once a second.
  - Dimensions are checked in policy order and stop at the first denial. The client IP comes first, so a denied source creates no further keys.
  - `RATE_LIMIT_PROFILE=budget` makes the local limiter authoritative. `replicated` uses the cache Redis as primary.
  - Outage behaviour is set per policy. `fail_closed` (authentication) answers 503. A local fallback (checkout/quote) uses per-instance budgets divided by `RATE_LIMIT_MAX_REPLICAS`, plus a per-process ceiling.
- **Sign-in limits:** 30 per IP per 15 minutes, 10 per identity and /24 (/48) network per 15 minutes, and 50 per identity per hour.
  - These are counted before the password is verified.
  - A successful sign-in clears the identity windows.
  - The response is a generic 429 with `Retry-After`.
  - Lockouts are temporary windows, never permanent.
  - The client IP is the gateway's `X-IH-Client-IP` (browser copies are stripped), because Nest is reachable only through the gateway. A value that is not an IP address falls back to the TCP peer.

## Alternatives considered

- Double-submit or synchronizer CSRF token now: it adds state and UI plumbing without closing any gap that SameSite=Strict, the Origin check and JSON-only bodies leave open for same-origin fetch flows.
- Origin enforcement in the gateway (Caddy): the API would then trust its deployment topology. In the API it is unit- and integration-tested, and it also protects direct calls in other environments.
- Sliding-window or token-bucket algorithms: fixed windows are simple, behave identically locally and in Redis, and are good enough at these limits. Burst at window edges is at most 2× the limit.
- Progressive sleep delays: they tie up API workers. Tiered windows (network, then identity-wide) give escalating restriction without holding connections open.

## Consequences

- Browser clients must send JSON with a same-origin `fetch`. Non-browser tools must send an allowed `Origin`.
- Limit values are starting points. Verify them in staging before release (M11).
- Password reset (33) and invite acceptance (34) add their own fail-closed policies. Checkout (75) and quote use `checkoutPolicy`/`quotePolicy`.
- **Accepted risk:** anyone who knows a staff email can delay that account's sign-in for up to one hour, through the 50 per hour identity window, from any network. This is never permanent. Identity-wide denials log at warn so they can alert (M11). Owner recovery is to wait for the window, or to restart the API in the budget profile.
- In the budget profile the limiter state and its per-process key secret are lost on restart, which clears every window. Restarts are operator actions, not attacker-controlled, so this is accepted.
- In the replicated profile the per-process secret is replaced by `RATE_LIMIT_KEY_SECRET`, which must be identical on every replica.
