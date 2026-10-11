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
