# 0025 — Storefront age gate: decision routes, routing gate and restricted page

- Date: 2026-10-11
- Status: accepted (copy and policy values pending BI-04)
- Step(s): 56 (ticket: 55, ADR 0024; generic preview and public pages: 57; store endpoints: 58)

## Context

Roadmap step 56: accept/reject routes, a routing gate and a restricted page, with an HttpOnly signed age cookie, a safe return URL, rejection clearing acceptance, and both the storefront server and the API checking the ticket. Architecture §9 adds Origin validation and rate limits on the decision POSTs and local-only return paths.

BI-04 is OPEN. Marina chose on 2026-10-11 to continue with placeholders.

## Decision

**Deny by default in `proxy.ts`.** The proxy runs for every request except build assets. A path is restricted unless `isPublicPath` lists it exactly: `/age-check`, `/restricted`, `/health`, `/api/age/accept` and `/api/age/reject`. The image optimizer (`/_next/image`) is gated too; only `/_next/static` and the favicon skip the proxy. A new page is therefore gated without anyone remembering to gate it. The proxy verifies the `ih_age` ticket for audience `storefront` with public keys; it reads nothing else about the client.

| Request state                     | Result                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| Valid ticket                      | Allowed. Gate pages redirect away (to the safe return path, or `/`). |
| No valid ticket, recent rejection | Redirect to `/restricted`, including from `/age-check`.              |
| No valid ticket                   | Redirect to `/age-check?return=<local path>`.                        |

GET/HEAD redirect with 307, other methods with 303. The redirect base is the request origin only when it is a configured storefront origin; otherwise the first configured origin, so a forged Host header cannot choose the destination. Every response that passes the proxy carries `Cache-Control: private, no-store`.

**Decision routes** (`POST /api/age/accept`, `POST /api/age/reject`; plain form posts, so the gate works without JavaScript):

1. Origin must be one of `STOREFRONT_ORIGINS`, or the one `null` case in the amendment below; a missing Origin is refused (403). (Amended 2026-10-14: `Sec-Fetch-Site` no longer refuses a request whose Origin is one of ours.)
2. Rate limit: 20 decisions per minute per client address, from the gateway's `X-IH-Client-IP` (the gateway strips browser-supplied copies). An unusable address shares one bucket.
3. Accept signs a ticket (the only signing call in the system), sets `ih_age` and clears the restricted marker, then 303 to the return path. Without a signing key it answers 503 and sets nothing.
4. Reject clears `ih_age`, sets `ih_age_restricted=1` and 303 to `/restricted`.

**Cookies.** Both are `Path=/; Secure; HttpOnly; SameSite=Lax`, with no Domain. `ih_age` lives for the ticket lifetime. `ih_age_restricted` lives for `AGE_RESTRICTED_MINUTES` (15, placeholder). The restricted marker is unsigned on purpose: it only takes access away, so forging it gains nothing and deleting it returns the visitor to the question, not to the store.

**Safe return path** (`safeReturnPath`): must start with a single `/`, contain no backslash or control character, be at most 512 characters, still resolve to our origin after URL parsing, and not point at the gate pages or `/api/`. Anything else becomes `/`. The `Location` header is always a relative path.

**Two independent checks.** The storefront proxy gates rendering; the API's `@AgeVerified()` (ADR 0024) verifies the same cookie for audience `api` on every store request. Neither trusts the other.

**Code layout.** `lib/age/policy.ts` is pure and unit-tested. `lib/age/handlers.ts` builds the two handlers from an injected runtime. `lib/age/runtime.ts` is the only storefront module that reads the signing key. `lib/age/copy.ts` holds the prototype wording.

## Waiting for BI-04

- Minimum age (18 assumed from the brief) and the final gate and restricted-page wording.
- Remembered duration (`AGE_TICKET_TTL_DAYS`) and policy version (`AGE_POLICY_VERSION`).
- How long a rejection lasts (`AGE_RESTRICTED_MINUTES`).
- The prototype's trade-licence line in the gate footer is omitted until the real number is supplied.

## Alternatives considered

- **Gate inside each page or layout.** Rejected: one forgotten page would leak. The proxy covers pages, RSC payloads and route handlers alike.
- **JSON fetch from a client component.** Rejected: the gate would need JavaScript, and a form post gets the same Origin protection.
- **Signed restricted cookie.** Rejected: it grants nothing.
- **Rate limit at the gateway only.** Deferred: Caddy's rate-limit module is not in the stock image; the edge limit arrives with Cloudflare (BI-06).

## Consequences

- Local development needs keys: run `pnpm age:keygen` and put the three lines in `.env`. Without them every page redirects to the age check and accepting answers 503.
- `next start` requires `APP_ENV=staging|production`, which requires https origins; a local production-mode run therefore needs `STOREFRONT_ORIGINS` set to the https origin the browser will send.
- **The storefront port must be reachable only from the gateway.** The limiter trusts `X-IH-Client-IP` because the gateway strips and sets it; a client that can reach the storefront directly could rotate that header.
- The limiter is per storefront process. More than one storefront replica multiplies the allowance until a shared limiter or the edge limit exists.
- Step 57 adds public policy pages to `isPublicPath`; nothing else should ever be added without review.
- The rejected state is device-local and short. It is a courtesy barrier, not verification.

## Amendment (2026-10-14, commit a307657)

Some privacy-mode browsers send `Origin: null` on a same-origin form post, which locked those shoppers out of the age check. The decision POSTs now accept:

- an Origin that is one of `STOREFRONT_ORIGINS`, whatever `Sec-Fetch-Site` says (a browser sets Origin to the page that made the request, so a match already means our page);
- `Origin: null` only together with `Sec-Fetch-Site: same-origin` and a request host (`X-Forwarded-Host`, else `Host`) equal to the host of a configured origin.

Everything else is refused: a missing Origin, a foreign Origin, and `null` with any other `Sec-Fetch-Site` (a sandboxed frame on another site sends `cross-site`).

Why the host check does not have to be trusted: `Sec-Fetch-Site` is set by the browser and cannot be set by page script, so the `null` case is reachable from a browser only on our own pages. A non-browser client can forge every header, but it can also send our real Origin; cross-site request forgery needs a victim's browser, and that browser tells the truth. The gateway also removes any client-sent `X-Forwarded-Host` (`strip_untrusted` in `infra/gateway/Caddyfile`) and sets its own from the request's Host. Tests: `apps/storefront/lib/age/age-gate.test.ts` ("origin validation", "accept and reject handlers").
