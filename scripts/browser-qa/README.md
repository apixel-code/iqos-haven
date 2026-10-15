# Browser QA harness (admin, through the real local gateway)

Headless Chromium drives the admin origin `http://localhost:8081` (Caddy gateway) against a
built API and the real worker consumers (media processing, signed cache invalidation) on an isolated `ih_test_*` schema of the **test** database.
The dev database is never touched; only synthetic accounts are created. Used for steps 42–51
and the step 54 acceptance pass (see `docs/verification.md`, "Browser QA").

## One-time setup (outside the repo; not a project dependency)

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.docker/bin:$PATH"
mkdir -p /tmp/ih-qa && (cd /tmp/ih-qa && npm init -y >/dev/null && npm i playwright-core@1)
# Chromium: the cached Chrome for Testing in ~/Library/Caches/ms-playwright is used by default;
# set QA_CHROMIUM to another Chromium executable if needed.
```

## Run

```sh
pnpm infra:up && pnpm build                       # infra + built api/worker/admin (or pnpm verify)
node scripts/browser-qa/qa-server.cjs &           # prints "QA backend ready on :4000 schema=ih_test_…"
APP_ENV=staging API_INTERNAL_URL=https://api.internal.invalid pnpm --filter @ih/admin start &
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/qa.mjs   # PASS/FAIL per check; screenshots in /tmp/ih-qa/shots
```

Afterwards stop both servers and drop the schema:
`node scripts/browser-qa/qa-server.cjs --drop ih_test_<id>`.

Notes: ports 3001, 4000 and 4099 (loopback QA status probe: counts only) must be free; the `API_INTERNAL_URL` value is a placeholder required by
the production admin start (the admin client only calls the same-origin `/api`). Real mobile
touch/keyboard and reset/invite submissions are not covered.

## Storefront shopper journey (steps 80–82, M7 gate)

`checkout.mjs` drives the whole journey at 360px against the stack served by the gate script:

```sh
pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   # prints SERVING, VARIANT, SCHEMA
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/checkout.mjs <SERVING> /tmp/ih-qa/shots <VARIANT> <SCHEMA>
```

Age check, product, variant, cart, quote, checkout form, a lost answer, a reload, an attempt that
was already placed, the confirmation page and its expired state, then a second order through a
changed total and a sold-out line. It changes the price and stock mid-journey with `psql` through
`docker exec` (override with `QA_PSQL`). The age answer is posted with the storefront's https
Origin, because the served storefront refuses the local http one; the button is not clicked.
The served stack also runs the worker's relay, queue and consumers on that schema (a private
queue prefix), and the journey checks that both orders reach the inbox. Stop the stack with
SIGTERM (`kill <pid>`): a process started in the background of a script ignores SIGINT, and then
its schema and queue keys are left behind and must be dropped by hand.

## Review link page (step 94)

`review.mjs` runs after `checkout.mjs` on the same served stack (it needs a placed order):

```sh
QA_PLAYWRIGHT_DIR=/tmp/ih-qa node scripts/browser-qa/review.mjs <SERVING> /tmp/ih-qa/shots <SCHEMA>
```

It takes the newest order to Delivered and creates a review link with the real `@ih/db` commands
(built packages, the served schema of the test database), then opens `/review#<token>` at 360px:
the page HTML holds no product, the token leaves the address bar and never reaches an API URL,
a Referer or device storage, an empty form sends nothing, a review is stored pending, the worker
writes the moderators' inbox notification, and a reload or the used-up link says it can't be used.
The age question's fragment hand-over is not covered here (the served gate redirects to the
https origin); it was checked once in Chromium with a stand-in server (docs/verification.md).
