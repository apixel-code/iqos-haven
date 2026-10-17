# Verification evidence — corrected archive

Date: 2026-10-08. Toolchain: Node 24.19.0 and pnpm 10.28.0. Results are from the corrective workspace, not claims inherited from the original ZIP.

| Check                                         | Result                  | Scope                                                                                            |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| pnpm install --frozen-lockfile                | PASS                    | Exact manifests and committed lockfile agree                                                     |
| pnpm build                                    | PASS                    | 11 Turbo build tasks: shared packages and four apps; Prisma client generated                     |
| pnpm lint                                     | PASS                    | 17 Turbo tasks including dependency builds                                                       |
| pnpm typecheck                                | PASS                    | 17 Turbo tasks including dependency builds                                                       |
| pnpm test                                     | PASS                    | 34 unit/HTTP fixture tests across 6 tested packages/apps; 14 Turbo tasks including builds        |
| pnpm format:check                             | PASS                    | Uploaded architecture and prototypes intentionally excluded from reformatting                    |
| pnpm test:boundaries                          | PASS                    | 9 ESLint probes, including invalid relative/import and allowed domain access                     |
| pnpm test:infra                               | PASS                    | 3 MinIO initializer probes: success, alias retry bound and propagated bucket failure             |
| pnpm test:package                             | PASS                    | Reference documents, ordered 132-step roadmap and no prototype checkout/confirmation persistence |
| pnpm contracts:generate / contracts:check     | PASS                    | Implemented health routes/error schemas; formatter-stable drift check                            |
| Empty production migration with --allow-empty | PASS (expected refusal) | Exit 1 before connecting; cannot silently skip production migrations                             |
| Explicit empty development migration          | PASS                    | Exit 0 with scaffold-only explanation                                                            |
| Inline JavaScript syntax                      | PASS                    | Both HTML prototype scripts parsed with node --check                                             |
| Architecture byte equality                    | PASS                    | Latest attachment and docs/architecture.md identical                                             |
| Final ZIP integrity/source inclusion          | PASS                    | CRC verification; required sources/docs included; generated/dependency/secret/Git files excluded |

Latest architecture SHA-256: `0fa17ee36071a53bb203c16df72833c9799ed772ab910003a642754f9b74bd00`.

## Not run or not established

Docker/Compose service execution and real PostgreSQL/Redis integration were not run: this execution environment does not provide Docker or running database/queue services. Consequently the corrected real-database harness, full API/worker dependency lifecycle, provider deployment and runtime grant behavior must be verified locally/CI before accepting the M1 gate. MinIO image digests could not be retrieved from its registry; official release tags and source references are recorded in infra/images.lock.json. Those references still need a successful image pull and execution check.

CI YAML was updated, but no GitHub Actions run was triggered. No real customer email was sent. Commerce race/idempotency/outbox recovery, browser age/cache boundaries, accessibility/visual approval, capacity, staging, production security, backup restore and rollback are pending because the corresponding business modules/infrastructure are not implemented. RPO/RTO remain unmeasured targets.

No milestone gate is declared complete by this foundation suite. Run `pnpm verify -- --integration` after local infrastructure is available, then the feature-specific acceptance cases as implementation proceeds.

## Local infrastructure run — 2026-10-08 (macOS, Node 24.21.0, Docker 29.8.2, Compose v5.5.1)

| Check                           | Result | Scope                                                                                      |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| pnpm install --frozen-lockfile  | PASS   | Node 24.21.0 (Node 25 is rejected by `engines`)                                            |
| pnpm infra:up                   | PASS   | postgres, redis-queue, mailpit healthy; minio up; minio-init exit 0 with 3 private buckets |
| PostgreSQL init roles/databases | PASS   | `ih_owner`, `ih_app`, `ih_test`; `iqos_haven`, `iqos_haven_test`                           |
| pnpm verify -- --integration    | PASS   | All foundation checks plus `test:int` (db 3 tests, api 1 test) against real PG18/Redis     |
| pnpm dev full boot              | PASS   | API live/ready 200 (`database: up`, `queue: up`); storefront/admin pages and `/health` 200 |
| Worker lifecycle                | PASS   | Worker started on `ih-system`, clean SIGTERM shutdown on watch restart                     |

Fixes needed for this run: official MinIO images are no longer publicly pullable from quay.io or Docker Hub, so Compose now pins Chainguard's MinIO and minio-client (`-dev`, has `/bin/sh`) builds by digest (see `infra/images.lock.json`); `turbo.json` sets `concurrency` to 16 because `pnpm dev` starts 11 persistent tasks (default limit 10). Staging, CI run and production-provider checks remain not run.

## Step 18 — audit log (2026-10-08, local)

`pnpm verify -- --integration` PASS (domain 27, db 7 + 11 integration, api 10 unit). Integration applies the real migration into an isolated schema: append inside `withTransaction()`, rollback with the failed mutation, root client refused, UPDATE/DELETE/TRUNCATE rejected by trigger (`append-only`) even for the owner, CHECK constraints, runtime-role privileges revoked. `pnpm db:migrate` applied `20261008151215_audit_log` to local `iqos_haven`; as `ih_app`, INSERT/SELECT succeeded and UPDATE/DELETE/TRUNCATE returned permission denied (one `manual-check` row remains in the local DB by design).

Release note: the migration revokes privileges only from a role named `ih_app`. If staging/production use a different runtime role name, revoke UPDATE/DELETE/TRUNCATE on `audit_log` for it during provisioning; the trigger still blocks mutations either way. Also fixed: `pnpm db:migrate` could not locate the Prisma CLI (package `exports` resolve to type stubs); it now uses the declared bin.

## Step 19 — outbox/effect schema and event contracts (2026-10-08, local)

`pnpm verify -- --integration` PASS (contracts 30 unit; db 19 integration). Integration applies all migrations into an isolated schema and checks: uuidv7 event IDs, snapshotted effects, duplicate (event, consumer) rejected, immutable payload, relay bookkeeping allowed, no delete of incomplete events/effects, completion blocked by unfinished effects, no late effects on completed events, dead/replay rules, prune path for completed events, payload bounds. Local `iqos_haven` migrated; `prisma migrate diff` shows no drift (hand-written partial indexes are ignored by Prisma). Grants: `ih_app` has no TRUNCATE on either table and no DELETE on `consumer_effects`; pruning needs a dedicated maintenance role (BI-08).

## Step 20 — atomic outbox writer (2026-10-08, local)

`pnpm verify -- --integration` PASS (db 32 integration, api 11 unit). Integration: a command writing a stand-in business row + audit + event commits all together and rolls all back together; root client refused; forged/dropped consumers, stale schema version, wrong aggregate type, unknown type, invalid aggregate version and PII payload rejected with nothing persisted; zero-consumer events complete at write with `dispatched_at` NULL; two publishes in one command yield distinct events/effects.

## Step 21 — worker lifecycle (2026-10-08, local)

`pnpm verify -- --integration` PASS (worker 7 unit + 5 integration, config 7). Worker integration on real Redis/PostgreSQL with unique queues: job processed and stable job ID deduplicated while present; concurrency peak equals the configured 2; `stop()` resolves only after the active job finished; production startup refused on an evicting policy; runtime policy flip triggers `onFatal`. Built worker started and stopped with SIGTERM (exit 0) at three timings; all three landed after startup had completed, so the SIGTERM-during-startup path is covered by code review only.

## Step 22 — leased outbox relay (2026-10-08, local)

`pnpm verify -- --integration` PASS (worker 13 integration, 12 boundary probes). Integration on real PostgreSQL/Redis: job enqueued with stable ID and IDs-only data, effect queued, event dispatched and lease released; no transaction of the relay pool is open while enqueueing (`pg_stat_activity`); concurrent claims are disjoint (SKIP LOCKED); a live lease is not reclaimed, an expired lease is, and the re-enqueue deduplicates to one job; enqueue failure and a hanging enqueue both record `ENQUEUE_FAILED` with a backoff lease and dispatch later; completed/zero-consumer events never claimed; loop start/stop. Manual: an event inserted as `ih_app` in local `iqos_haven` was dispatched by the built worker in one attempt (that effect stays `queued` until the step-23 runner exists).

## Step 23 — effect runner (2026-10-08, local)

`pnpm verify -- --integration` PASS, and `turbo run test:int --force` passed twice more (worker 24, db 32, api 1). Worker integration on real PostgreSQL/Redis: side effect + completion + event completion commit together; 5 concurrent duplicate deliveries apply once; transient failure rolls back the side effect, schedules a stable retry job and early duplicates claim nothing; permanent and exhausted failures go dead with safe codes; expired running lease reclaimed and the stale runner cannot complete; crash loop goes dead at the budget; concurrent sibling effects complete the event; external work heartbeats, stores its receipt and aborts on lease takeover; writer → relay → queue → effect worker end to end. Tests use a unique BullMQ prefix (a sentinel key in the real `ih:` namespace survived the suite). Found and fixed: Prisma `@default(now())` used the Node clock, making fresh effects briefly unclaimable under Docker clock skew; migration `db_clock_defaults` moves defaults to PostgreSQL with no Prisma drift. Manual: a probe inserted as `ih_app` in local `iqos_haven` was completed by the built worker in one attempt.

## Step 24 — reconciler, replay, schedules; M2 gate demonstration (2026-10-08, local)

`pnpm verify -- --integration` PASS and one forced integration repeat (worker 35, db 32, api 1; unit 98). M2 gate demonstrated locally against real PostgreSQL/Redis: a synthetic `system.probe` event written by the outbox writer is dispatched by the relay, its Redis job is destroyed (queue obliterated), the reconciler re-enqueues it after the stale window, a duplicate copy of the original job is also delivered, and the effect completes exactly once (attempts 1) with the event completed; nothing remains stranded. No email exists or is sent. Also covered: live leases never re-enqueued, expired/overdue work recovered, bucketed reconcile IDs, dead listing without payloads, audited replay (reason required), missed-completion repair, scheduler slot uniqueness across two replicas, bounded catch-up after downtime, one-slot leases under slow runs, retry→failed, crash reclaim and crash-loop → failed. Manual: the built worker's reconciler recovered the real orphaned dev effect (`manual-relay-check`, job previously deleted) to completed. Found and fixed: BullMQ rejects custom job IDs with ":" beyond its 3-part legacy form, which had silently broken step-23 retry scheduling (masked by a fake enqueuer in tests); IDs are now colon-free and a test enqueues every ID form into real BullMQ. CI has not run (no remote).

## Known-issue fixes after step 24 (2026-10-08, local)

`pnpm verify -- --integration` PASS (unit 98, integration 68). Fixed: zero-consumer events now take `completed_at` from the database-generated `created_at` (no application clock left in outbox writes); reconciler query split per status (`UNION ALL`, merged oldest-due first) with new `consumer_effects_queued_idx`/`consumer_effects_running_idx` and the unused `consumer_effects_active_idx` dropped — `EXPLAIN` on local `iqos_haven` shows index scans for every branch, `prisma migrate diff` shows no drift; cache/queue Redis guard treats loopback aliases (`localhost`, `127.x`, `[::1]`) as one instance. Built worker on the dev stack: probe completed, no warnings/errors.

### Bug log (all found so far)

| Found   | Bug                                                                                | Fixed in                                   |
| ------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Setup   | Official MinIO images no longer pullable                                           | baseline (Chainguard, digest-pinned)       |
| Setup   | `pnpm dev` exceeded turbo concurrency 10                                           | baseline                                   |
| Step 18 | `pnpm db:migrate` could not resolve the Prisma CLI                                 | step 18                                    |
| Step 19 | Trigger functions resolved tables via caller `search_path`                         | step 19 (`SET search_path FROM CURRENT`)   |
| Step 23 | Integration tests obliterated the real dev effect queue                            | step 23 (unique test prefix)               |
| Step 23 | Prisma `@default(now())` used the app clock (fresh effects unclaimable under skew) | step 23 (`db_clock_defaults`)              |
| Step 24 | BullMQ rejected `:` job IDs beyond 3 parts; step-23 retry jobs silently failed     | step 24 (colon-free IDs, real-BullMQ test) |
| Post-24 | Zero-consumer events still used the app clock                                      | this fix                                   |
| Post-24 | Reconciler OR-query could not use partial indexes                                  | this fix (`reconciler_indexes`)            |
| Post-24 | Redis guard missed loopback aliases                                                | this fix                                   |

## First CI run — PR #1 (2026-10-08)

GitHub Actions run 37818768532 on `fix/known-issues` (PR #1 → `main`): PASS in 2m13s — install, format, build, lint, typecheck, unit (98: config 7, domain 32, db 8, logger 2, worker 7, contracts 31, api 11), boundaries, infra, package, contracts drift, integration on CI PostgreSQL 18 + Redis (68: api 1, db 32, worker 35, including the M2 gate recovery test). Runs were not created while the repository was private on the free plan without any visible error; they started after the repository was made public. Annotations: actions/checkout, setup-node and pnpm/action-setup v4 run on a deprecated Node 20 runtime (forced to Node 24); `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.

## Step 25 — email adapter and template pipeline (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 112, integration 73). Email integration against local Mailpit (also added to CI): one Bcc message per effect with `Message-ID`/`X-IH-Delivery-Key` = delivery key and receipt stored; duplicate delivery of a completed effect sends nothing; disabled adapter sends nothing yet completes; staging allowlist filters/suppresses; unreachable SMTP → retry. Unit: strict boolean/env safety rules, test env refuses non-local SMTP, HTML escaping, header-injection refusal, delivery key stability, permanent/partial classification. Built worker with the local `.env` logs "email sending disabled". No real email was sent.

## Resend adapter (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 130, integration 73). Resend adapter tested against a local stub of the batch API (no request reached api.resend.com): one email per recipient without Bcc, Idempotency-Key = delivery key, identical request on retry regardless of planner recipient order, >100 recipients split into stably keyed chunks, error classification (400/422/404/405 and idempotency conflict permanent; 401/403/409-concurrent/429/5xx and incomplete success bodies retried), provider messages never carried, abort honoured. Config: Resend needs a `re_…` key, an allowlist outside production, a local stub URL in tests, and https otherwise. No real email was sent; the sending domain is not verified yet (BI-07).

## Step 26 — object storage and private service auth (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 162, integration 79, 14 boundary probes). Storage against real MinIO with the least-privilege service user: round-trip in all three buckets; anonymous GET refused (403); the service identity cannot create buckets, set bucket policies or reach other buckets; presigned download works then expires; quarantine POST rejects oversize, other-key and other-type uploads and accepts a valid one; bounded reads refuse oversize objects. Service auth: tampered method/path/query/body, another service's key, disallowed or unknown callers, stale timestamps, replays, missing raw body and an unavailable nonce store are all refused; key rotation verifies. API boots with the new env (health ready). MinIO init now sets anonymous access to none and creates `ih_service` with an object-only policy (re-runnable); CI starts MinIO with the same script.

## Step 27 — identity schema and permission seeds (2026-10-09, local)

`pnpm verify -- --integration` PASS (domain 66 unit incl. the Owner/Staff matrix; db 38 integration). DB seeds equal the domain catalogue and role grants exactly; email normalization/uniqueness, argon2id-only hashes, 32-byte token hashes, ≤ 7-day session lifetime and revoke-reason rules are enforced by constraints. Runtime grants are checked with production-like default privileges; on local `iqos_haven` as `ih_app`: `SELECT … FOR UPDATE` on the owner role succeeds, any roles UPDATE is rejected by trigger, permission inserts and staff deletes are denied. The `SET ROLE ih_app` lock test runs in CI (skipped locally where ih_test is not a member of ih_app). Reviewer blocker fixed before commit: revoking UPDATE on roles would have made the last-Owner `FOR UPDATE` lock impossible for the runtime role.

## Step 28 — first-Owner bootstrap and password hashing (2026-10-09, local)

`pnpm verify -- --integration` PASS (domain 75, platform 29, api 28 unit; db 43 integration). Bootstrap integration: one normalized Owner + audit (personal fields redacted); refused on re-run and after deactivation; 5 concurrent bootstraps → exactly 1; an Owner insert that skips `lockOwnerRole` waits on the new database trigger; non-Owner writes unaffected. CLI (unit): no password argument accepted, mismatch/weak/identity-containing passwords create nothing, existing Owner refused before any prompt, aborted prompt handled, NFKC normalization. Manual on a throwaway database (dropped afterwards; the dev DB has no Owner): first run created the Owner (argon2id m=65536,t=3,p=1, audit `staff.owner_bootstrapped`), second run refused before asking for a password, weak password rejected. `pnpm identity:benchmark`: ~64 ms/hash with defaults on a 2026 Apple-silicon laptop — production parameters must be tuned on the production runtime.

## Step 29 — same-origin gateway (2026-10-09, local)

`pnpm verify -- --integration` now includes `pnpm test:gateway`: the real Caddyfile in the pinned Caddy image against stub upstreams — 29 checks (routing per origin, `/api/v1` → `/v1` rewrite, age route to storefront, internal/health/admin-from-storefront/store-from-admin 404, raw and encoded traversal, stripping of X-Age-Verified/X-Forwarded-_/X-Real-IP/Forwarded/X-Request-Id/X-IH-_, Connection-header abuse, gateway request ID echoed, cookies and `__Host-` Set-Cookie intact, no Server/Via banner, SSE streamed unbuffered, 64 KB API body limit). Manual: Compose gateway → real Nest API returned the API's own 404 envelope with the gateway request ID; health not reachable through the gateway.

## Step 30 — admin sign-in and sessions (2026-10-09, local)

`pnpm verify -- --integration` PASS (api 31 unit + 12 integration on an isolated schema through the real Nest app). Covered: cookie attributes and 7-day Max-Age, token never stored (only its hash), minimized metadata, Owner 33 / Staff 15 permissions on `/me`, identical generic 401 for wrong password, unknown email, inactive user, malformed email and over-long password, 400 on unknown fields, `no-store` on success and error responses, logout revocation, 12 h idle and 7 d absolute expiry, 5-minute last-seen throttle without extending expiry, deactivated user denied on the next request, hash upgrade on login, re-login revoking the presented session, and no session when the password changed after verification. Manual end to end on a throwaway database (dropped): `bootstrap:owner` → sign in through the gateway's admin origin (cookie set) → `/me` → sign in via the storefront origin refused (404) → logout → `/me` 401.

## Step 31 — access guard, permissions and field filtering (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 236 incl. domain field-policy 6; integration 117 incl. api 28; gateway 29). `access.int.test.ts` on an isolated schema through the real Nest app with probe routes: boot refused for an undeclared route, class-level `@Public` and an unserialized permission route; test modules refused in production; unknown permission keys rejected at declaration; 401 without/garbage/revoked session; Owner sees aggregate spend and revenue, Staff gets the same response without them (nested array included); public route with no caller strips policy fields and ignores stale cookies; Staff 403 on an Owner-only POST with valid and invalid bodies (guard before validation); Owner 400 on invalid input; all-of permission semantics; controller-level policy with handler override; contract violation → generic 500 without the leaked value; permission removed in the DB → 403 on the next request; deactivated user → 401; admin cookie never accepted on an internal route; `@NoResponseBody` drops the handler's value.

## Step 32 — Origin/CSRF controls and endpoint limiters (2026-10-09, local)

`pnpm verify -- --integration` PASS (unit 256 incl. platform limiter 11, config 3 new, api origin rules 6; integration 128 incl. api 39). Real app (`security.int.test.ts`): login/logout refused without the admin Origin, with an evil or storefront Origin, or with cross-site `Sec-Fetch-Site` (403, no cookie, no session); text/plain and form bodies 415; encoded `/v1/%61uth/login` and `//auth` paths classified as admin; safe GETs untouched; 10 failed sign-ins per identity+network then 429 with Retry-After even for the right password, while another network or another account still works; 30 attempts per IP then 429; success clears the identity window; junk `X-IH-Client-IP` falls back to the peer; replicated profile with an unreachable cache Redis answers 503 (fail closed). Real Redis: 20 concurrent consumes across two limiter instances admit exactly 5; TTL set; reset works.

## Milestone 2 gate — closed 2026-10-09

Closed on Marina's approval. Conditions and evidence: synthetic `system.probe` event processed by the worker; duplicate delivery and Redis job-loss recovery (`recovery.int.test.ts` "M2 gate", `effects.int.test.ts` duplicates, manual orphan recovery on the dev stack); no real email in tests (Mailpit/local stubs only). All M2 steps (18–26) merged; `main` CI green at a2429f7 (run 37894960188). Production Redis durability/failover and restore drills remain release work (M11, BI-06).

## Step 33 — password-reset request/consume and durable email (2026-10-09, local)

`pnpm verify -- --integration` PASS: build, lint, typecheck, format, unit 266, integration 139, boundary/reference/infra/contract checks and gateway 29. API reset integration (8 new tests) exercises generic known/unknown/inactive/malformed accounts, 30-minute hash-only storage and IDs-only outbox, five simultaneous consumes (exactly one succeeds), sibling invalidation, all-session revocation, weak-password rejection without burning a token, NFKC, expired/inactive/changed/tampered tokens, rollback of password/token/sessions when audit fails, actual database lock wait proving an old-hash session cannot commit behind password change, Origin/strict DTOs, 429/Retry-After and 503 for missing config/shared-limiter outage. Worker reset integration (3 new tests): real PostgreSQL + EffectRunner + Mailpit delivery, completed-job duplicate, old-key immutable retry, suppression of used/expired/inactive/changed-user/changed-recipient links, missing key retry and mismatched event ownership refusal. Unit tests cover purpose-keyed token reproduction/selector validation and reset configuration. Invariant reviewer identified the old-password login race; fixed user-lock/recheck, second review clean.

Frozen lockfile checked with `pnpm install --offline --frozen-lockfile --lockfile-only`. No package versions changed. Initial build/type errors were corrected before the full successful run; the sandboxed Next build was interrupted and rerun with local process/network access. Tests used isolated schemas and local sinks only. No real reset email, live migration or reset-key provisioning performed. Admin reset UI is step 37; separate key/origin configuration is required to enable the endpoints. ADR 0006 describes delivery, rotation and compromise limitations. This does not close M3.

## Step 34 — staff invitations and acceptance (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 274, integration 151, boundary/reference/infra/contract checks and gateway 29. Invitation API 9 new tests through real Nest/PostgreSQL: Owner issue/revoke allowed, Staff/anonymous denied, strict roles/inputs, hash-only 24-hour snapshots and IDs-only email outbox, five concurrent accepts yielding exactly one saved-role account, no auto-login, resend/revoke/idempotent audit, existing/inactive account refusal, expiry/tamper/inactive inviter, weak password preserving link and NFKC, immutable snapshots, issue/accept rollback on audit failure, actual Owner-role lock wait followed by revocation rejecting stale acceptance, three concurrent resends leaving one pending invitation, repository-level Staff denial, Origin/429/Retry-After and missing-key/shared-limiter 503. Worker 3 new integration tests: real Mailpit + EffectRunner delivery/duplicate, stable retained-key retry, accepted/revoked/unauthorized/existing-recipient suppression, retryable missing config and ownership denial. Unit tests add separate reset/invitation PRF purpose and invite configuration validation. Invariant review: no issues.

Tests run on isolated schemas and local sinks only. No real email, live migration, key provisioning or identities changed. Invite UI remains step 37. Expiry/limits are starting policies documented in ADR 0007, requiring staging review. No M3 gate closed.

## Step 35 — versioned staff administration (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 278, integration 161, boundary/reference/infra/contract checks and gateway 29. Ten new real Nest/PostgreSQL integration tests cover Owner/Staff/anonymous access; bounded keyset pagination and sanitized responses; invalid fields/UUIDs, whitespace-only names, duplicate email and stale versions; concurrent profile edits with one winner and no-op audit behavior; email change revoking all sessions/reset tokens and old-email login; self-email cookie clearing; deactivation revoking sessions/reset/issued invitations and idempotency; rollback on failed audit; deterministic session creation blocked on a user-row lock then rejecting an old identity version despite unchanged password; shared limiter outage returning 503; simultaneous Owner self-deactivations preserving one active Owner. Event catalogue unit coverage includes the two new IDs-only event types. Invariant reviewer: no issues.

The first targeted run exposed whitespace-only name validation mapped to 500; the service now maps the domain identity validation error to 400, verified in the green full run. Tests use isolated schemas and local sinks. No live migration, real email, secret/config provisioning or real identities changed; existing schema suffices. Step 36 continues shared fixed-role/reactivation administration, and UI remains step 37. No M3 gate closed.

## Step 36 — shared identity guard and fixed-role administration (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 282, integration 172, boundary/reference/infra/contract checks and gateway 29. Eleven new API integration tests through real Nest/PostgreSQL cover Owner/Staff/anonymous access, unknown roles/fields/UUIDs/version rejection; promotion/demotion with fresh seeded grants and revocation of multiple sessions/reset verifiers; self-demotion cookie/issued-invitation revocation; reactivation with saved role/password while old capabilities remain revoked; inactive role changes, stale writes and no-op audit/version; audit rollback and direct repository Staff denial; competing role/reactivation expected-version commands; actual Owner-role lock wait followed by demoted actor rejection; pre-role-change login version fencing; authoritative limiter outage; mixed concurrent self-demotion/deactivation and two concurrent self-demotions preserving one active Owner. Existing step-35 deactivation regressions also pass after extracting shared transaction support. Event unit tests cover the two new IDs-only types. Invariant reviewer: no issues.

Initial targeted failures: new POST commands used default 201 instead of documented 200 (explicit HttpCode added), fixture outbox field corrected to eventType and JSON parsed via contract for typing. Existing auth cookie test assumed DB/app clocks differed by less than ten seconds; it now verifies Max-Age against the stored expiry and request timing while retaining the exact seven-day database duration and all cookie security attributes. API regression rerun: 77 tests pass; full suite above is green. Tests used isolated schemas/local sinks only. No live migration, new secrets/configuration, real email or real identities changed. Unavailable-Owner recovery is documented; production operational recovery still requires provisioning/rehearsal. UI remains step 37; no M3 gate closed.

## Step 37 — admin identity pages and session-aware navigation (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 295 (13 new admin tests), integration 172, boundary/reference/infra/contract checks and gateway 29. New admin tests cover same-origin/no-store/JSON/cookie request semantics, strict current-profile validation, 401/403 handling, empty reset/invite/logout responses, Retry-After and generic errors without server detail leakage, fragment consumption/history scrubbing with duplicate/missing/oversized rejection, abort propagation/request timeout setup, Staff vs financial/settings/staff/SEO navigation, individual grants rather than role/wildcard and revoked-permission navigation removal. Invariant review: no issues.

Nine production-page/gateway HTTP smoke checks PASS against a built admin and real API using an isolated test schema/synthetic identities: all four auth pages rendered with no-store/no-referrer/no demo password; anonymous workspace HTML contains only session-check state, no private profile; anonymous API 401; Staff login and current permission profile; direct Owner-only staff API 403; real logout clears cookie and old session gets 401. Email was disabled; temporary preview shutdown drops the test schema. Final admin checks rerun after making the initial light document theme explicit and handling replacement fragments on already-open link pages. Offline frozen lockfile check passed; only a contracts workspace dependency link added, no package versions changed.

Browser visual/interactive verification NOT RUN: IAB/Chrome browser surfaces unavailable and native Computer Use permission denied. HTTP/unit checks do not establish browser interaction, mobile layout appearance, actual fragment lifecycle or expired-session redirect behavior in a browser; these remain QA follow-ups in PROGRESS. Initial setup failures (noninteractive offline install and stale generated Next dev route types) and final fragment-change React effect/type diagnostics were resolved before the green final suite. Production preview required an explicit staging profile/HTTPS internal URL placeholder; no `.env` edits. No real email/identities, live migration, PR push/merge or M3 gate closure.

## Step 38 — typed Owner-only settings API (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 297, integration 180, boundary/reference/infra/contract checks and gateway 29. Eight new real Nest/PostgreSQL integration tests cover Owner/Staff/anonymous access and no-store reads; absent groups with null/version 0; strict keys, versions, nested fields, domains, HTTPS social links, E.164 numbers, recipient limits/duplicates and allowed template placeholders; concurrent first writes with one winner, stale conflicts and unchanged no-ops; rollback of initial-row creation and existing updates when audit fails; all four typed groups, metadata-only audit and IDs-only outbox; versioned null clear; real database key/version/JSON/FK constraints and immutable keys; deterministic Owner-role lock wait followed by actor demotion rejecting stale authority; direct repository authorization and shared-limiter outage returning 503. Event catalogue unit tests cover the new settings event. Invariant reviewer: no issues.

The initial build exposed the shared DTO factory's object-only typing; the strict discriminated write union now uses a static schema DTO accepted by the existing validation pipe. The first full verification exposed generated OpenAPI formatting drift; the generator now resolves the repository Prettier configuration, and the repeated full run above passed. Targeted API regression also passed (85 tests). No dependencies changed.

Migration applied only to isolated test schemas. No settings seeded, live migration, real email, new secrets, `.env` edits or real identities changed. Saving notification/WhatsApp configuration does not activate delivery or automation; email safety configuration remains unchanged. Real brand/contact/WhatsApp and remaining email inputs are pending BI-01/BI-09/BI-07. Step 39 delivery schema/API can proceed without invented BI-03 values; step 40 provides admin forms. Step 37 browser QA remains pending, and no M3 gate closed.

## Step 39 — Dubai delivery areas and flat-fee/ETA configuration (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 304, integration 191, boundary/reference/infra/contract checks and gateway 29. Eleven new real Nest/PostgreSQL integration tests cover Owner/Staff/anonymous permissions on every route, empty/unconfigured state without seeds, strict bounded query/path/body inputs, integer fee/disabled free threshold, stable Dubai area identity and case-insensitive unique names, bounded cursor pagination, concurrent initial configuration and area edits, expected-version conflicts/no-op metadata, versioned null clear, private audit/IDs-only events, failed audit/outbox rollback including the absent-row sentinel, actual database configuration/area constraints, deterministic shared-lock waits for area deactivation and fee changes, stale demoted actor denial after the Owner guard wait and shared-limiter outage. Domain tests exercise inactive/missing/non-Dubai denial, unconfigured fail-closed selection and integer/explicit-zero flat fee; event catalogue tests include the two IDs-only events.

Initial build failures were DTO instance typing (corrected with declared validated fields). Invariant review found duplicate-name raw UPDATE errors were not mapped from Prisma P2010/PostgreSQL 23505 to 409; fixed and verified by an API rename-collision regression checking unchanged version/audit. Second invariant review: no issues. Targeted API suite passed (96 tests). The full suite was repeated after the review fix and the final run above passed on the corrected source.

Local infrastructure was healthy; tests applied migrations only to isolated schemas and used local sinks. No live migration, approved real coverage/fee/ETA, `.env` changes, dependencies, real emails/identities or PR push/merge. BI-03 remains OPEN; free threshold stays disabled. Internal selection is a building block for later quote re-acceptance/order snapshots; no public delivery/checkout surface or business milestone gate is claimed. Step 40 admin forms/auth acceptance and step-37 browser QA remain pending.

## Step 40 — admin settings, staff and delivery forms (2026-10-10, local)

`pnpm verify -- --integration` PASS: format, production builds, lint, typecheck, unit 316 (12 new admin tests; admin total 25), integration 191, gateway 29 and boundary/reference/infra/contract checks. New tests cover cookie/no-store/JSON request and strict-response semantics, bodyless commands, safe path constraints, cancellation/deadlines, generic error/Retry-After handling, versioned complete settings groups, recipient/URL/template validation, exact decimal-to-integer fee conversion and absent/disabled delivery values. Existing real Nest/PostgreSQL auth/reset/invite, field-denial, staff deactivation and concurrent last-Owner regressions pass. Invariant reviewer: no issues.

Browser QA PASS through the actual local admin gateway with a built admin, isolated test schema and synthetic accounts: Owner login; settings empty state and versioned save; concurrent stale save returning conflict, blocked controls and explicit reload; unsaved draft retained after focus refresh; delivery `0.29` AED save verified as 29 fils by the real API; inactive area creation and versioned activation; last-active-Owner deactivation rejected; staff profile save, deactivation with authoritative reload and reactivation; invitation queue receipt without a delivery claim; logout; Staff navigation/direct settings denial; revoked Staff session returns to expired-session sign-in on visibility refresh. Reset/invite synthetic fragments are removed from the address bar before showing new-password controls; no new credentials were entered or submitted in the browser.

Visual inspection PASS: desktop field alignment, light/dark settings and 375×812 login/settings/delivery/staff layouts. Mobile QA exposed sidebar/grid minimum-content overflow; bounded grid tracks and sidebar min-width fixed it, followed by a passing final admin production build and repeated mobile visual inspection. Real mobile touch/keyboard interactions and browser new-password reset/invitation submission NOT RUN; they remain manual QA, not a full acceptance or M3 gate claim. Screenshots were inspected, not archived.

Initial React effect lint and formatting failures were corrected before the green full suite. The sandboxed build was interrupted; the authorized build passed. Rebuilding during preview required restarting the preview and fresh navigation to load the new CSS assets. No dependencies, live migration, `.env` changes, approved business data, real emails/identities or PR push/merge. Email was disabled. Temporary Guest browser and QA servers were closed; the isolated QA schema was removed (shutdown's redundant drop reported already absent).

## Step 41 — catalogue schema and constraints (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 316; integration 206 incl. db 58; gateway 29; boundaries 14). `packages/db/src/catalogue.int.test.ts` (15, isolated schema): seven empty tables with no seeds; UUIDv7/DB-clock/positive-version/inactive-draft defaults; malformed and duplicate slugs incl. trashed rows; money bounds, decimal rejection, compare-at above base; publish needs tax ref/version, positive price, live row, puff count for disposables; option name/value normalization and bounds; canonical option signature, global SKU, one default, per-product combination uniqueness and a concurrent equivalent-insert single winner; stock starts at zero, changes only with the transaction-local ledger flag (CHECK still applies, flag does not leak); runtime role has no catalogue DELETE/TRUNCATE; image key/metadata bounds incl. `//`, hidden and `..` names, one primary; RESTRICT deletes and missing parents; namespace-scoped redirect reservations and concurrent live-slug/redirect claim serialization. Migration not applied to the shared dev database.

## Step 42 — brand administration (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 322 incl. admin 31; integration 222 incl. api 111, db 59; gateway 29). `brands.int.test.ts` (15, real app + isolated schema): Staff create/edit with atomic audit and IDs-only `catalog.changed`; SEO hidden from Staff in detail/list and 403 on Staff SEO writes, Owner round trip; invalid/unknown input 400, anonymous 401, unknown 404; case-insensitive duplicate names and slugs incl. trashed 409 `DUPLICATE`; stale version `VERSION_CONFLICT`, trashed edits refused, no-op unversioned incl. empty Owner SEO; four concurrent same-version edits → one winner; trash refused with `IN_USE` while a live published product uses the brand, allowed for drafts, trashed/live lists, restore; slug rename redirect, alias reserved, reclaim; keyset paging stable and ordered; malformed cursors 400; inactive actor rechecked in-transaction; trashed-brand publish refused and five publish-vs-trash races never leave a published product on a trashed brand; missing `catalog.trash` grant → 403. DB: published product refused on trashed brand or category. Admin Brands screen not exercised in a browser.

## Step 43 — category administration (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 323 incl. admin 32; integration 230 incl. api 119; gateway 29). Brand suite (15) unchanged and passing after the shared-repository refactor. `categories.int.test.ts` (8): Staff create/edit with `catalog.category_*` audit and `catalog.changed` (`entityType: "category"`), no-store, `imageKey`, no description; SEO Owner-only; invalid/unknown fields (incl. description) 400, 401, 404; case-insensitive duplicate names and taken slugs `DUPLICATE`; trash `IN_USE` with a published product, allowed with drafts only, publish refused while trashed, `TRASHED` edits, restore; five publish-vs-trash races never leave a published product in a trashed category; slug redirect/reclaim with separate brand namespace; stale `VERSION_CONFLICT` on edit/trash/restore, unversioned no-op, oversized cursor 400; keyset order; missing `catalog.write` grant 403. Categories screen not exercised in a browser.

## Step 44 — product administration (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 328 incl. admin 37; integration 243 incl. api 132; gateway 29). `products.int.test.ts` (13, real app + isolated schema):

- **Create:** Staff creates a draft disposable with typed specs and integer fils; there is one `catalog.product_created` audit entry and an IDs-only `catalog.changed` event. Kits get kit specs and a null puff count.
- **Invalid input (all 400, with the product count unchanged):** fractional, negative or oversized fils; compare-at not above base; zero puffs; wrong specs for the type; float or too-precise decimals; too many extra rows; bad slug; client-supplied status or tax treatment; unknown fields; NUL in text.
- **Parents:** a trashed or missing parent gives `PARENT_UNAVAILABLE`.
- **SEO:** Owner-only, including 403 for Staff when the value is unchanged.
- **Slugs:** a duplicate slug gives `DUPLICATE`, and a rename creates a redirect.
- **Versions:**
  - A no-op is not versioned.
  - A stale edit gives `VERSION_CONFLICT`.
  - Audit records change flags and no description text.
  - Four concurrent same-version edits produce one winner.
- **Published products:** edits keep the published-state rules (`PUBLISH_REQUIREMENTS`, `PARENT_UNAVAILABLE`) and never change status.
- **Check order:** an unknown id gives 404 and a stale version gives `VERSION_CONFLICT`, even when the target parent is trashed. A draft stays editable after its own brand is trashed.
- **Concurrency:** a product move racing a brand trash stays consistent.
- **List:** status/brand/category filters, literal `%`/`_` search, newest-first cursor; bad query values give 400.
- **Permissions:** without the `catalog.write` grant, writes give 403 while reads still work.

The Products screen has not been exercised in a browser.

## Step 45 — product options and variants (2026-10-10, local)

Verification: `pnpm verify -- --integration` PASS (unit 331 incl. admin 40; integration 254 incl. api 143; gateway 29).

`variants.int.test.ts` (11 tests) covers:

- **No-option products:** a product without options gets exactly one active default `{}` variant. A second one is `DUPLICATE`, and an inactive first variant is `DEFAULT_REQUIRED`.
- **Combinations:** canonical lower-case flavour/nicotine combinations. Missing, extra or unknown values are `INVALID_COMBINATION`. A key-order or case variant of an existing combination is `DUPLICATE`.
- **SKUs:** global uppercase uniqueness, and malformed SKUs get 400.
- **Option structure and values:**
  - Structure is locked once variants exist, including the single-variant case (`OPTIONS_IN_USE`). A used value cannot be removed.
  - Unused values can be removed, and the product version increases.
  - A stale product version is `VERSION_CONFLICT`. Bad option payloads get 400.
- **Default variant:**
  - The default cannot be unset or deactivated.
  - The default moves atomically, and the old default can then be deactivated.
  - A stale variant version is `VERSION_CONFLICT`.
- **Stock:** it never appears in bodies (400).
- **Concurrency:**
  - Four concurrent first variants end with exactly one default.
  - Option value removal racing variant creation never leaves a variant on a removed value.
- **Audit and events:** audit lists option values, and there is exactly one product-level `catalog.changed` per change (none keyed by variant).
- **Access:** without `catalog.write`, Staff get 403 on POST, PUT and PATCH. Reads still work. Unknown products get 404 and trashed products get `TRASHED`.

The variants card has not been exercised in a browser.

## Step 46 — stock ledger and inventory API (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 331; integration 266 incl. api 155, db 59; gateway 29).

`inventory.int.test.ts` (12) covers:

- **Movements and history:** initial/restock/damage/manual movements with exact balances and newest-first history (actor name shown). Audit has four entries and no note text. The reconciliation query returns empty.
- **Stock limits:**
  - Stock never goes below zero (`INSUFFICIENT_STOCK`), with nothing written.
  - Initial stock is accepted only as the first movement (`INITIAL_STOCK_EXISTS`).
  - Balances are capped (`STOCK_LIMIT`).
- **Validation:** sign, note, reason and bounds are validated (400). Unknown variant → 404.
- **Replays and concurrency:**
  - The same command replays.
  - A changed payload, or the same ID on another variant, gives `COMMAND_REUSED`.
  - Four concurrent duplicates apply once.
  - Three concurrent duplicates that exhaust the stock replay instead of conflicting.
  - Eight concurrent −1s against 3 units: exactly 3 succeed, and balance equals ledger.
- **Insert shapes:** an `ON CONFLICT DO NOTHING` skip leaves stock untouched. A multi-row insert with one bad balance rolls back. A movement for a missing variant is refused (FK).
- **Tamper protection:** ledger UPDATE and DELETE are refused, and direct stock UPDATE is refused even with the old session flag.
- **Trashed products:** stock can still be adjusted.
- **List:** stock states (out/low/in) are correct; filters, literal SKU search and the keyset cursor work.
- **Permissions:** 403 without `inventory.adjust`, while reads still work.

DB test: the movement must state the correct resulting balance (`IH002` otherwise).

## Step 47 — set stock and inventory UI (2026-10-10, local)

`pnpm verify -- --integration` passed:

- unit 333, including admin 42;
- integration 272, including api 161;
- gateway 29.

`inventory.int.test.ts` grew to 18 tests:

- **Initial and later sets:** the first count records `INITIAL_STOCK`. Later counts record the computed `MANUAL` delta with its note. A count equal to the balance records nothing.
- **Stale balance:** a set based on a stale balance gets `STOCK_CHANGED` and changes nothing. Bad targets and notes get 400.
- **Concurrent sets:** four concurrent sets from the same view give exactly one winner. The rest get `STOCK_CHANGED`, and the reconciliation query stays empty.
- **Retries:** a retried set replays, including a first set retried after the balance moved. Three concurrent duplicates apply once. Audit records the command kind and no note text.
- **Reused IDs:** a reused ID with another target gets `COMMAND_REUSED`. So does a set ID used for an adjustment.

The admin unit tests cover the add/remove/set command builders. The Stock screen has not been exercised in a browser.

## Step 48 — quarantine media upload (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 334 incl. platform 47; integration 280 incl. api 169; gateway 29).

`media.int.test.ts` (8 tests) ran against real MinIO:

- **Upload path:**
  - An authorized upload is stored in private quarantine, its key is pinned, and the media bucket is not involved.
  - Completing it gives `uploaded` with size and ETag. Audit and one `media.uploaded` event are written, and a second completion changes nothing.
- **Storage policy refusals:** MinIO refuses an oversized upload, a re-keyed one, and a re-typed one; completion then reports `UPLOAD_MISSING`.
- **Rejections:** objects written around the policy are `rejected` (`size_mismatch`/`type_mismatch`). They get no event, an audit entry, and free their slot.
- **Refusals:** a trashed product gets `TRASHED` on completion. Bad declarations (svg, gif, 0 B, > 8 MiB, unknown fields) get 400 and nothing is signed. An unknown product gets 404.
- **Limits and expiry:**
  - Twelve concurrent authorizations give exactly 8, and the next one gets `IMAGE_LIMIT`.
  - An expired grant frees its slot and is listed as `expired`.
  - Completing after expiry gets `UPLOAD_EXPIRED`.
- **Permissions:** without `media.upload` Staff get 403 while reads still work; anonymous requests get 401.

Platform unit test: presigned uploads are signed for the public endpoint, never the internal one.

Browser upload (CORS on the quarantine bucket) is part of step 50 and BI-06.

## Step 49 — media processing and cleanup (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 342 incl. platform 55; integration 286 incl. worker 52; gateway 29).

`image.test.ts` (8 tests):

- signature sniffing: JPEG/PNG/WebP only, so SVG and GIF are refused;
- derivatives are metadata-free WebP, never enlarged, and the source sha256 is recorded;
- EXIF orientation is applied;
- a mismatch between the declared type and the actual bytes is rejected;
- truncated or corrupt files are rejected;
- animated WebP and APNG are rejected;
- side and pixel bounds hold, with a compressible decompression bomb refused;
- the byte cap is enforced.

`media.int.test.ts` (worker, 6 tests, real PostgreSQL and MinIO):

- **Processing:** through `EffectRunner` exactly once, giving `ready` with dimensions, sha256 and three private WebP derivatives without EXIF, plus an audit entry. A duplicate job is a no-op.
- **Rejections:**
  - replaced bytes are rejected as `object_changed`;
  - disguised SVG, truncated JPEG and an undersized image are rejected with no derivatives;
  - an asset from before the consumer existed is backfilled once (idempotent), processed, and rejected as `object_missing`.
- **Cleanup:**
  - a just-expired grant is kept through the grace period;
  - expired and rejected originals are purged after the grace period;
  - a processed original is kept for 24 h, then purged while its derivatives remain;
  - a repeated cleanup run is harmless.

## Step 50 — product image gallery (2026-10-10, local)

`pnpm verify -- --integration` PASS:

- unit 345 (admin 45)
- integration 293 (api 176)
- gateway 29

`gallery.int.test.ts` has 7 tests:

- **Attach:**
  - Ready assets are attached; the first becomes primary and the order stays dense.
  - Previews are 10-minute signed links to `.webp` derivatives in the media bucket, never quarantine.
  - Re-attaching the same asset is idempotent.
  - Audit is written.
- **Refusals:**
  - Uploaded, processing, rejected and removed assets give `MEDIA_NOT_READY`.
  - Another product's asset gives 404.
  - Raw SQL inserts are refused by the trigger.
  - Failed uploads stay visible with their error code.
- **Concurrency:** ten concurrent attaches give exactly 8 images, one primary and order 0..7. The next attach gives `IMAGE_LIMIT`.
- **Edits:**
  - Alt edits work.
  - Moving the primary works; unsetting it gives `DEFAULT_REQUIRED`; a stale version gives `VERSION_CONFLICT`.
  - Reordering works; a wrong set gives `ORDER_MISMATCH`.
- **Removal:** the next image is promoted to primary, the order stays dense, the asset becomes `removed` and its slot is freed.
- **DB integrity:**
  - An attached asset cannot leave `ready` or change product.
  - A stale remove is refused.
  - A removed asset cannot be re-attached.
  - An asset missing a derivative is refused.
- **Permissions:** without the `catalog.write` grant the API returns 403 while reads still work. Anonymous → 401, unknown product → 404, trashed product → `TRASHED`.

The admin unit tests cover the upload pre-check, form field order, rejection copy and reordering. The Images card has not been exercised in a browser.

## Browser QA — catalogue, stock and media screens (2026-10-10, local)

**Setup:**

- Headless Chromium (Playwright, cached Chrome for Testing) through the real local gateway admin origin `http://localhost:8081`.
- Built admin served on 3001.
- Built API on 4000, plus the real `media_processor` consumer driven in a loop.
- An isolated `ih_test_*` schema in the test database; the dev database was not touched. Synthetic Owner and Staff only. Real local MinIO.

**Result: 19/19 checks PASS.**

- Owner sign-in.
- Brand: created, with the slug suggested from its name.
- Category: created.
- Product draft: saved with AED→fils, compare-at and typed specs.
- Variants:
  - flavour × nicotine options generated 4 variants;
  - exactly one is the default.
- Images:
  - a JPEG carrying EXIF was uploaded straight to quarantine and processed by the worker;
  - "Add to gallery" made it the primary;
  - the thumbnail loads from a signed media-bucket WebP link, never quarantine;
  - a GIF was refused in the browser.
- Stock: a count was set to 12 (initial), then 2 removed as damaged with a note; the history shows actor and note.
- No failed requests during the Owner journey.
- Staff: no SEO fields, and denied Owner-only settings.
- Mobile: no horizontal overflow at 375 px on the products, inventory and brands screens.
- Screenshots were inspected; they were not archived.

**Found and fixed:** the "Add product" editor recreated its response contract on every render. That reloaded the resource endlessly: the form stuck on "Loading current values…", Save stayed disabled and typed values were lost. Unit and integration tests could not see this. The contracts are now module-level constants. After the fix, the admin was rebuilt and the full journey passed.

**Not covered:**

- Real mobile touch/keyboard.
- Dark theme via the in-app toggle (the app uses its own theme switch, not the OS preference).
- Reset/invite new-password submission.
- Storefront.

## Step 51 — publication, trash/restore and purge (2026-10-10, local)

`pnpm verify -- --integration` PASS (unit 346; integration 305 incl. api 188; gateway 29).

`publication.int.test.ts` (12 tests):

- **BI-02 gate:** a complete product still reports `tax_treatment`, and publish answers `PUBLISH_REQUIREMENTS`. (Superseded 2026-10-12 by ADR 0036: a complete product now publishes without a tax reference.)
- **Requirements:** every missing requirement is listed, including a zero-price variant override.
- **Publish and move to draft:**
  - Staff can do both once the product is ready. Zero stock does not block publishing.
  - A repeated publish is a no-op. A stale version gets `VERSION_CONFLICT`.
  - Each change writes exactly one audit entry and an event.
- **Concurrency:**
  - Three concurrent publishes give one audit entry.
  - Publishing racing removal of the last image never leaves a published product without an image.
- **Published products stay publishable:** removing the last image, deactivating the default, and shortening the description below 20 characters are all refused with `PUBLISH_REQUIREMENTS` and rolled back.
- **Trash and restore:**
  - Trashing a published product makes it a trashed draft. Publish then gets `TRASHED`, and a second trash gets `TRASHED`.
  - The Trash list shows `trashedAt`.
  - Restore brings it back as a draft; restoring again gets `NOT_TRASHED`.
- **Purge:**
  - A live product gets `NOT_TRASHED`, and Staff get 403.
  - The Owner purge removes the product, variants and media rows plus 4 storage objects in real MinIO, and writes an audit entry.
  - Stock history blocks purge with `IN_USE` and nothing is deleted.
  - The DB function refuses a live product even when called directly (`IH003`).
- **Permissions:** without the publish or trash grant → 403. Unknown product → 404, anonymous → 401.

**Browser QA through the gateway (27/27 PASS)** extended the step-50 journey:

- the Publishing card explains the accountant-dependent tax treatment, and Publish stays disabled;
- move to trash, the Trash tab, and a purge refused because of stock history;
- restore as a draft;
- a history-free product purged by the Owner after ticking "I understand this cannot be undone" (the button is disabled until then);
- Staff see no permanent delete;
- no unexpected failed requests.

The QA schema was dropped afterwards.

## Step 52 — catalogue cache and invalidation (2026-10-10, local)

`pnpm verify -- --integration`: exit 0. Unit 362, integration 314, gateway 29.

- **Bounds (unit, `packages/platform/src/cache/cache.test.ts`):** a TTL above 60 s is refused; entries expire at the TTL; LRU eviction at the entry bound; the byte bound holds for multi-byte text and keys; an oversized value is not cached.
- **Stale data:** a load that began before an invalidation is neither stored nor joined by later readers, on one process and across two replicas sharing a (fake) Redis.
- **Miss control:** one load per key for concurrent callers; concurrent misses capped; a full wait queue is refused.
- **Replicated profile (fake Redis client):** entries shared with a TTL, one invalidation reaches both replicas, outage falls back to bounded local reads and invalidation rejects so the caller retries. NOT RUN against a real cache Redis: the cache-Redis Compose profile is not part of local infra yet.
- **Private route (`apps/api/src/cache/revalidate.int.test.ts`, real API):** a signed worker call answers 204 and drops the cache; unsigned, storefront-signed, cookie-only and replayed requests answer 401 without invalidating; invalid bodies answer 400.
- **Post-commit invalidation:** creating a brand through the admin API drops the cache and queues a `storefront_revalidate` effect in the same commit; reads and denied requests do not.
- **Worker (`apps/worker/src/revalidate.int.test.ts`, real PostgreSQL, signature verified by a stub server):** completes once after a signed call; a 503 is retried and then succeeds; an unreachable API or rejected key retries and ends dead; an unconfigured target completes as skipped.
- **Storefront:** the new ESLint rules were shown to reject `next/cache`, `revalidate`, `force-cache` on a probe file (removed).
- **Gateway:** `/api/v1/internal/revalidate` stays unreachable (existing checks).

Not covered: a real store read through the cache (step 58), and the invalidation-lag alert (observability step).

## Step 53 — low-stock transitions (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 378, integration 321, gateway 29.

- **Rule (unit, `packages/domain/src/inventory.test.ts`):** above → at/below crosses; already low, partial restock and restock above do not; threshold edits follow the same rule; one alert per excursion over a stock sequence.
- **Real API + PostgreSQL (`apps/api/src/inventory/low-stock.int.test.ts`):**
  - one IDs-only `inventory.low` event on reaching the threshold, none while low, silent re-arm above it, a second event on the next crossing;
  - zero stock leaves the product published and the variant active;
  - ten concurrent removals crossing together emit exactly one event;
  - a replayed and a concurrently duplicated command emit once;
  - a counted set emits; a refused (stale) set and a no-change set emit nothing;
  - a threshold edit emits once with cause `threshold` and the new variant version, does not repeat while low, and lowering it re-arms;
  - event and movement share one inserting transaction.
- **`invariant-reviewer`:** no blockers, no should-fix.

Not covered: the notification/email consumers (step 92) and stock writers from orders (steps 75–76, 85–86), which must call `publishLowStockCrossing`. The reconciliation job has no dedicated test; its query is asserted empty in the inventory tests.

## Step 54 — catalogue/inventory acceptance pass (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 381, integration 325, gateway 29.

**Real API + PostgreSQL (`apps/api/src/catalogue/acceptance.int.test.ts`):**

- **SKU conflicts:** a SKU used by another product is refused on create (case-insensitive) and on rename, leaving the variant unchanged; two products racing for one new SKU get exactly one 201 and one 409.
- **Option sold-out:** one flavour out while the other sells; then the product is sold out but every variant stays active and listed; stock on an inactive variant does not count (`productAvailability`, also unit-tested).
- **Concurrent adjustments:** six removals, three counted sets from the same view and three restocks race; each applies or answers `STOCK_CHANGED`, at most one set wins, every movement's balance continues from the previous one, the ledger equals the balance, and low-stock events equal the crossings in the ledger.
- **Cache propagation:** brand, category, product, options and variant changes each drop the cache and queue a `storefront_revalidate` effect; reads do not.

**Already covered and re-run in the suite:** safe upload (media/gallery tests, worker media tests) and safe purge (publication tests).

**Browser QA through the gateway (32/32 PASS)**, with the real media and invalidation consumers on an isolated schema. New checks:

- a duplicate SKU is refused with "already used" and the variant stays at version 1;
- removing the last units shows "Out of stock · 0 in stock" and raises exactly one low-stock event;
- all nine `storefront_revalidate` effects completed with `invalidated:204` (signed worker call accepted by the API guard).

The QA schema was dropped afterwards. Two harness fixes: the script resolved the repo path wrongly when it contains spaces, and the staff-settings check raced the client render.

**M4 gate: NOT passed.** Create variant product, process image and set stock are demonstrated; publish is refused by design until BI-02 supplies an approved tax treatment. Not covered: real mobile touch/keyboard QA; a real cache Redis; storefront display of sold-out options (steps 58–61).

## Step 55 — age-ticket signer, verifier and key ring (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 396, integration 330, gateway 29.

- **Ticket (unit, `packages/platform/src/age/age-ticket.test.ts`):** round trip for both audiences; expiry exactly at `exp`; 60 s skew bound; signing and accepting above 30 days refused; tampering with version, key id, payload or signature refused; a relabelled key id fails the signature; unknown and retired keys refused; rotation overlap works; wrong audience, changed policy and any non-exact claim set refused even when correctly signed; key material validated; conflicting or oversized cookies read as none.
- **Configuration (unit):** key ring parsing; `unapproved` policy refused in production; 30-day cap; staging/production need keys; the storefront's private key must match its listed public key; API, worker and admin never keep the private key and refuse it when deployed.
- **API guard (`apps/api/src/auth/age.int.test.ts`, real API, probe store route):** product data only with a valid ticket; previous key accepted during rotation; expired, future-dated, tampered, other-policy and malformed tickets answer 403 `AGE_VERIFICATION_REQUIRED` with no product data and `no-store`; crawler user agents, headers, query flags and an Owner session do not pass; a second conflicting cookie is refused; no configured key refuses everything.
- **`invariant-reviewer`:** no blockers and no forgery path. Fixed: key-pair consistency check, keys required when deployed, canonical key encoding, refusal log at debug level.

Not covered (later steps): storefront accept/reject routes and cookie attributes (56), generic preview (57), real store endpoints and their cache headers (58). BI-04 values are placeholders.

## Step 56 — storefront age gate (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 433 (storefront 36 new), integration 330, gateway 29.

**Unit (`apps/storefront/lib/age/age-gate.test.ts`), through the real handler functions:**

- **Return path:** local paths kept; absolute, scheme-relative, backslash, control-character, traversal, over-long, gate, API and framework paths fall back to `/`.
- **Routing:** every path restricted unless listed exactly; unverified → age check with a safe target; any ticket failure treated as none; verified shoppers leave the gate pages; a recent rejection keeps the device on the restricted page; a valid ticket outranks the marker.
- **Handlers:** accept sets `ih_age` (`Secure; HttpOnly; SameSite=Lax`, 30 days) with a ticket that verifies for both the storefront and the API, and clears the marker; reject clears `ih_age` and sets the 15-minute marker; foreign, missing and cross-site origins get 403 and no cookie; 20 decisions per minute per address, junk addresses share one bucket; no signing key → 503, nothing set.

**Smoke through the real gateway (`http://localhost:8080`, built storefront, throwaway key, curl):**

| Request                                                       | Result                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Unverified `/`, deep link, crawler User-Agent, RSC request    | 307 to `/age-check` (deep link keeps `return`), `private, no-store` |
| `/_next/image`, an unlisted `/api/age/status`, POST to a page | Redirected to the gate (303 for POST)                               |
| Accept without Origin / foreign Origin                        | 403, no cookie                                                      |
| Accept with `return=https://evil.example/`                    | 303 to `/`                                                          |
| Accept                                                        | 303 to the local return path; `ih_age` set HttpOnly                 |
| Verified `/`                                                  | 200, `private, no-store`                                            |
| Forged cookie `ih_age=true`                                   | Redirected to the gate                                              |
| Reject, then `/` and `/age-check`                             | 303 to `/restricted`; both then redirect to `/restricted`           |
| 22 rejects with rotating browser-sent `X-IH-Client-IP`        | 429 after the 20th decision (the gateway strips the header)         |
| Forged `Host` sent straight to the storefront                 | Redirect to the configured origin, not the forged host              |
| Private key                                                   | Not in served HTML or `.next` output                                |

The smoke run used `APP_ENV=staging` with `STOREFRONT_ORIGINS=https://localhost:8080` and sent that Origin from curl, because `next start` requires a deployed environment and deployed origins must be https. The local gateway container was restarted first: it had been running since 2026-10-09 with a configuration older than the repository's.

- **`invariant-reviewer`:** no blockers. Fixed: `/_next/image` now passes the gate; redirect base no longer follows a forged Host; decision routes listed exactly.

Not covered: a real browser run of the gate pages (no browser QA journey for the storefront yet), Safari with `Secure` cookies on plain-http localhost, catalogue pages behind the gate (57–64). Copy and policy values are placeholders (BI-04).

## Step 57 — generic store preview and public policy pages (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 436, integration 330, gateway 29, age-preview 877.

**`pnpm test:age-preview` (new, part of `pnpm verify`; built storefront over real HTTP, throwaway key):**

- **Eight User-Agents** (phone browser, Googlebot, Bingbot, Facebook, WhatsApp, Twitter, Slack, none) × **ten restricted URLs** (home, shop, product, brand, cart, checkout, sitemap, three image-optimizer forms), GET and HEAD: each is a 307 to `/age-check` on our own origin, `private, no-store`, `noindex`, with no JSON-LD, price, product Open Graph or microdata, and nothing about the requested product in the body.
- **Gate page per agent:** 200; `og:title`/`og:site_name` "Iqos Haven", the generic description, the generic `og:image` on the configured origin, robots `noindex, nofollow`; the requested product URL appears only in the hidden return field; the metadata set is identical for every agent.
- **Forged signals** (verification headers, `ih_age=accepted`, a malformed ticket, bearer token, crawler IP headers, RSC/prefetch headers, query flags): still gated.
- **Public information:** `robots.txt` disallows everything and names no sitemap; `/opengraph-image` is a PNG; `/responsible-use`, `/terms`, `/privacy` answer 200, `noindex`, no catalogue data.

**Unit:** policy pages are public by exact path and stay readable after a rejection, while the age question does not; near-miss paths stay gated.

- **`invariant-reviewer`:** no blockers and no gate regression. Its three script hardening points are done (HEAD, stricter forged-signal assertions, body-level product words).

Not covered: how WhatsApp/Facebook actually render the preview (staging, architecture §9); real product pages (the check's URL list is synthetic until steps 59–61); the final policy text (BI-04/legal) and the indexing decision (BI-05).

## Step 58 — gated store catalogue reads (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 436, integration 342 (store 12 new), gateway 29, age-preview 877.

**Real API + PostgreSQL + signed ticket (`apps/api/src/store/store-catalog.int.test.ts`):**

- **Age gate:** all four routes answer 403 `AGE_VERIFICATION_REQUIRED` with no product data for no cookie, a forged cookie, a tampered ticket and a crawler User-Agent, even after a verified shopper warmed the cache.
- **Headers:** `Cache-Control: private, no-store` and `Vary: Cookie` on success; `no-store` on 404 and 429.
- **Visibility:** only the published product of a live, active brand and category with an active variant is listed or readable; draft, trashed, inactive-brand, inactive-category, no-active-variant and unknown slugs give identical 404 bodies; brand and category lists and counts follow the same rule.
- **Contract:** integer-fils prices (override or base), lowest active price on the card, compare-at only when higher, active variants only, one default, availability flags; no SKU, stock count, threshold, tax reference, version or staff ID anywhere in the body.
- **Images:** signed 10-minute links to the media-bucket derivatives, primary first, never quarantine.
- **Sold out:** product stays listed, marked `soldOut`, options listed and unavailable; an inactive stocked variant does not count.
- **Former slug:** resolves to the product with its current slug; a redirect to a hidden product is a 404.
- **Sorting and paging:** four sorts in the expected order with ties on product ID, identical results for page sizes 1/2/3/48, filters by brand, category and type.
- **Bounded input:** out-of-range limits, unknown sorts, types and parameters, repeated parameters, bad slugs, malformed, forged, out-of-range and wrong-sort cursors all answer 400.
- **Cache:** reads stay cached until invalidation; unpublishing disappears at the next invalidation; 30 unknown slugs and 30 well-formed forged cursors add no cache entries; a product published after a miss is visible at once.
- **Degraded data:** stored specs that do not fit the contract show as no specifications.
- **Rate limit:** 240 of 250 rapid reads from one address succeed, the rest answer 429; another address is unaffected.

- **`invariant-reviewer`:** no blockers, no injection, visibility or field leak. Fixed: forged cursors could reach the database and fail; unknown slugs and cursor pages are no longer cached; cursor validated before any load.

Not covered: these routes through the storefront pages (59, 61); stock changes reaching the cached availability sooner than the TTL (by design); image delivery through a CDN (BI-06).

## Step 59 — storefront listing, brand and category pages (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 449 (storefront 52), integration 342, gateway 29, age-preview 1368.

**Unit (`apps/storefront/lib/store/store.test.ts`):** address-bar values reduced to known ones (tracking, unknown, malformed and repeated values dropped); links without defaults; fils formatting without floats and refusal of non-integer or negative amounts; discount percent; card text and badges; the catalogue client forwards only the age ticket and client address, never calls the API without a ticket, sends only contract parameters, maps refusal/404/failures distinctly, rejects off-contract bodies and encodes slugs into one path segment.

**`pnpm test:age-preview` (built storefront, stub API, real HTTP):**

- Unverified requests to the new URLs, for eight User-Agents, GET and HEAD: redirected to the age check; **no request reaches the API** before anyone is verified.
- A verified shopper (sending extra cookies and an Authorization header): `/shop` shows names, "AED 45", "AED 59", "AED 49.50", "Sold out", "−24%", "New", "7K puffs · 4 options" and "Next page"; the API saw only `ih_age`, the client address and `?brand=orbe&sort=price_asc`; tracking and unknown parameters reach no link, form or API call; the second page renders through the cursor; the type pages fix their filter and it cannot be overridden; the brands index hides an empty brand; a brand page shows its header and title; unknown brand and category answer a real 404; every page is `private, no-store`.
- **After that warm-up**, the same URLs without a ticket, with a crawler User-Agent, a forged cookie and an RSC header are still redirected, with no catalogue data and **no extra API call**.
- API refuses the ticket → 307 to the age check. API down → 500 with no data or internals.

**Real browser (headless Chromium via the check's `--serve` mode, screenshots reviewed):** `/shop`, `/brands`, `/brands/orbe` at 360 px and 1280 px: no horizontal overflow, no page errors; changing the sort navigates to `?sort=price_asc`; "Next page" loads the second page.

- **`invariant-reviewer`:** no blockers; forwarding, input handling, caching and client bundle clean. Hardening done: formatter refuses bad amounts, image links must be http(s), unused error prop removed.

Not covered: these pages against the real API and database in one run (the API side is covered by the step-58 tests, the page side by the stub); real product images in the card (the stub sends none); real mobile touch testing.

## Step 60 — store search, suggestions and facets (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 457, integration 355 (search 13 new), gateway 29, age-preview 1481.

**Unit:** `normalizeSearchTerm` (letters and digits only, six tokens, 64 characters; operators, quotes, wildcards and control characters removed; Unicode kept); storefront search state (known filters only, dirhams to fils, malformed numbers and reversed ranges ignored, bounded lists).

**Real API + PostgreSQL (`apps/api/src/store/store-search.int.test.ts`):**

- **Gate:** search and suggestions answer 403 without a valid ticket; `private, no-store`, `Vary: Cookie`.
- **Matching:** names, brands, type words, puff counts ("7k", "10000") and active option values by word prefix; every word must match; a name match outranks an option match.
- **Near misses:** "hallo" finds the Halo products and is marked approximate; numbers are never matched roughly; "mint" does not return "Mini"; near-miss results page correctly and a cursor stays in its pass when the catalogue changes.
- **Hidden data:** drafts, products of inactive brands and inactive option values are never found.
- **No results:** zero total, empty facets, no error.
- **Hostile text** (SQL fragments, tsquery operators, `%`, `_`, backslash, markup, NUL, Arabic, emoji): 200, treated as plain text; the echoed term is letters, digits and spaces only.
- **Facets:** exact counts for types, brands, puff counts, nicotine, price range, in stock and on sale; each facet ignores its own filter; combined filters; facets follow the search term.
- **Sorting and paging:** five sorts walked one item at a time with no duplicates, and `total` equals the walked count.
- **Bounds:** 26 malformed requests answer 400, including out-of-range numbers, reversed ranges, too many values, wrong-sort and forged cursors.
- **Projection:** new product, product rename, brand rename, added option, deactivated option and unpublish are reflected at once.
- **Suggestions:** visible products and brands from two characters; nothing for one character or hidden data.
- **Rate limit:** 60 of 65 rapid searches from one address succeed.

**`pnpm test:age-preview`:** `/search` is gated like every page; for a verified shopper it shows the term, total, filters and paging; the API receives only validated parameters with prices in fils; the term is not in the page title; the similar-results notice and no-result state render; markup in the term is escaped; a cursor the API refuses restarts the list (search and shop).

**Real browser (headless Chromium, screenshots reviewed):** `/search` with results and with none at 360 px and 1280 px, no overflow or page errors; the header field keeps the term; searching from the header and submitting the filter form navigate correctly.

- **`invariant-reviewer`:** no blockers; no injection path or visibility leak. Fixed: cursor remembers its pass, stale cursors restart the list, sorted lock order and extension-schema check in the migration.

Not covered: suggestions in a browser through the gateway (the serve mode has no gateway, so the suggest call 404s there); search against a large catalogue (performance is unmeasured); a database whose `pg_trgm` is not in `public`.

## Step 61 — product page, option selection and safe add (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 470 (storefront 68), integration 355, gateway 29, age-preview 1600.

**Unit (`apps/storefront/lib/store/selection.test.ts`):**

- **Selection:** only values an active variant has are offered; nothing is chosen when there is a real choice; a single-value option is filled in; the exact variant resolves with its own price; a sold-out choice stays sold out even when another strength is in stock; a combination nobody sells is "unavailable", never the nearest one; choices that do not single out one variant offer nothing; each value is judged against the other choices.
- **Cart:** same variant merges; 10 per item and 50 items enforced and reported; stored value has only variant ID, slug, quantity and a display snapshot; unreadable, off-schema or extended values (an added phone or address field) read as an empty cart.

**`pnpm test:age-preview`:** `/p/…` is gated; for a verified shopper it shows the name, "From" price, option groups with no radio checked, description, specification rows, COD line and nicotine warning; the title names the product while link-preview tags stay generic and there is no JSON-LD; a former slug answers 308 to the current one; unknown product 404; an impossible slug makes no API call; after warm-up an unverified request is still refused with no API call.

**Real browser (headless Chromium, 20 checks, screenshots reviewed at 360 px and 1280 px), run before the review fixes below:**

- nothing preselected; "Add to cart" without a choice says "Choose flavour and nicotine first." and stores nothing; with one option chosen, "Choose nicotine first.";
- price follows the chosen variant (AED 49 for 50 mg; "Save 24%" for the reduced one); "In stock" shown;
- quantity 2 added: storage holds one line with the chosen variant ID, "grape ice · 50 mg", 4900 fils;
- choosing a sold-out option: "This option is sold out", button disabled and labelled "Sold out", the choice unchanged; an unoffered combination: "This combination isn't available", "Not available"; the cart unchanged throughout;
- legacy `co` and `lastOrder` keys removed; the only storage key is `ih_cart_v1`; sessionStorage empty;
- a sold-out card has no quick add; quick add falls back to the product page when the API route is not reachable.

- **`invariant-reviewer`:** no blockers. Fixed afterwards (covered by unit tests and `pnpm verify`, not by a second browser run): ambiguous matches offer nothing; the related section cannot fail the page; legacy keys are cleared on every page, not only when the cart is used; a failed storage write no longer loses the addition; store slugs use the slug schema.

Not covered: the quick-add dialog itself in a browser (it needs the gateway to reach the API; the serve mode has none) — its buy box is the same component exercised on the product page; real product images in the gallery; swipe gestures; the cart page (step 62).

## Step 62 — device cart, quantities and availability (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 478 (storefront 76), integration 356, gateway 29, age-preview 1676.

**Real API + PostgreSQL (`store-catalog.int.test.ts`, cart refresh):** only active variants of visible products are returned; inactive, draft and unknown IDs are absent and a repeated ID appears once; name, brand, option text in option order, price (override or base), previous price, in-stock flag and thumbnail are correct; no SKU, stock count or version in the body; a price change, a deactivation and an unpublish show on the next read (not cached); empty, malformed, 51-ID and extra-parameter requests answer 400; no ticket answers 403 with no product data.

**Unit (`selection.test.ts`, cart section):** quantity limits and remove; unconfirmed view from the device snapshot; server price and name applied with a price-change note; sold-out and withdrawn lines stay visible, flagged and out of the subtotal; a flagged line stays flagged when another line changes and nothing new is known; repeated IDs in stored text are dropped; integer fils throughout.

**`pnpm test:age-preview`:** `/cart` is gated; the server-rendered frame carries no catalogue data.

**Real browser (headless Chromium, refresh route stubbed in the browser, 20 checks, screenshots reviewed at 360 px and 1280 px):**

- header count; the refresh asks for exactly the cart's variant IDs;
- "Price changed from AED 45 to AED 47 since you added it."; sold-out and no-longer-available lines flagged with their own text, quantity locked, struck-through totals;
- subtotal counts only buyable lines at current prices (2 × 47 + 49 = AED 143); "Remove the unavailable items before checking out."; checkout disabled;
- a quantity change updates the total, persists and does not refetch;
- removing one line while the next refresh fails leaves the sold-out line flagged and uncounted;
- a failed refresh on load keeps the cart from the snapshot and says the figures are confirmed at checkout;
- empty state; "View cart" after adding on the product page; the only storage key is `ih_cart_v1`.

- **`invariant-reviewer`:** no blockers. Fixed: server answers are kept per variant, so changing another line cannot clear a flag; stored duplicates dropped; neutral "Loading your cart…" frame before the device cart is read.

Not covered: the refresh through the real gateway in a browser (the route itself is covered by the API test; the browser run stubs it); checkout (not built).

## Step 63 — saved items, compare and recently viewed (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 486 (storefront 84), integration 357, gateway 29, age-preview 1828.

**Real API + PostgreSQL (`store-catalog.int.test.ts`, product cards):** cards come back in the order asked; a former slug resolves to the current one (and both together resolve to the same product); unknown, draft and redirect-to-draft slugs are absent; sold-out is flagged; `private, no-store`; empty, malformed, 25-slug and extra-parameter requests answer 400; no ticket answers 403 with no product data.

**Unit (`lib/device/lists.test.ts`):** save newest first and unsave; full list refused and reported; three kits at most; recently viewed unique, newest first and capped at 12; only slugs accepted (phone numbers, emails, paths and mixed case refused); remove from one list; renames followed everywhere without duplicates; stored value has only `v`, `saved`, `compare`, `recent`; unreadable, off-schema or extended values read as empty.

**`pnpm test:age-preview`:** `/wishlist` and `/compare` are gated; their server-rendered frames carry no catalogue data.

**Real browser (headless Chromium, API routes stubbed in the browser, screenshots reviewed at 360 px and 1280 px), run before the review fix below:**

- the heart on a card saves and marks the product (phone and desktop);
- saved items show current cards; a renamed product is followed and re-stored under its new slug; a gone product is reported and removed only on request; unsaving removes the card; empty state copy;
- opening a product records it; the rail never shows the product being viewed and shows the others;
- the product-page save button works; disposables have no compare option;
- compare shows two kits with price, battery, output, pod capacity and availability; lowest price, largest battery and highest output are highlighted (confirmed in the screenshot; the script's own assertion for this used a bad locator and reported FAIL); removing kits updates the list and shows "Add one more kit";
- storage holds only `ih_lists_v1`, slugs only; sessionStorage empty; no page errors.

- **`invariant-reviewer`:** no blockers. Fixed afterwards (verified by `pnpm verify`, not by a second browser run): the comparison follows renames, so "Remove" works on a renamed kit; a product remembered under two slugs is shown once.

Not covered: these features through the real gateway in a browser; the compare page with a renamed kit in a browser; a control to clear recently viewed (not built).

## Step 64 — store shell, WhatsApp links and age-boundary verification (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 491 (storefront 89), integration 358, gateway 29, age-preview 1847, gate 1803.

**`pnpm test:gate` (new): real built API on an isolated schema + real built storefront + real gateway container, over HTTP through the gateway.** Seeded: one published product, one draft, and Owner settings with a WhatsApp number, a private message template and a notification recipient.

- **Refused, cold and again after a verified shopper warmed the API cache:** twelve page URLs (plain and as RSC requests, including the image optimizer) redirect to the age check; nine API routes answer 403 `AGE_VERIFICATION_REQUIRED`; no product name, price, WhatsApp number or other setting in any body; all `no-store`. Tried eight ways: no cookie, crawler user agent, preview fetcher, forged headers, junk cookie, ticket signed by another key, expired ticket, ticket for another policy.
- **Accept/reject through the gateway:** accept without an Origin is 403; accept sets an HttpOnly, Secure cookie and redirects to the local return path; reject clears it and the browser is sent to the restricted page.
- **Verified shopper:** home, shop, brand, search, product and cart pages render with the product, price and options, `private, no-store`; the draft product is a 404 and never appears; the footer carries the WhatsApp link; store info is exactly the number; product list, detail, suggestions, cart refresh (visible variants only, stock as yes/no) and saved-item cards work through the gateway; no SKU, template or recipient anywhere.
- **Storefront origin:** admin, auth, internal and health API routes answer 404.

**API (`store-catalog.int.test.ts`):** store info returns only the configured number behind the ticket; templates and recipients never leave; a value that is not a phone number reads as not configured.

**Unit:** WhatsApp link building (no link without a valid number; the message cannot change the URL; wording per context); the recheck path shows the age question instead of looping.

**`pnpm test:age-preview`:** home shell content, WhatsApp links with and without a configured number, API refusal → `/age-check?recheck=1` which shows the question.

**Real browser through the real gateway (headless Chromium, 14 checks, screenshots reviewed at 360 px and 1280 px):** home; search suggestions; navigation marks the current section; the quick-add dialog opens with nothing preselected, refuses to add without a choice, blocks the sold-out option and stores exactly the chosen variant; the cart is confirmed by the API with the right subtotal; saved items load; no failed requests or page errors on the journey; a browser without the ticket is redirected and its direct API call gets 403. This closes the earlier "only run with stubs" gaps for quick add, suggestions, cart refresh and saved items. The browser pass ran before the review fixes below; those are covered by `pnpm verify`.

- **This step's own run found a bug in new code:** the shell imported its navigation list from a client component file, so verified pages answered 500. Fixed by moving the list to a shared module; `test:gate` and `test:age-preview` now cover it.
- **`invariant-reviewer`:** no blockers. Fixed: no redirect loop when the API refuses a ticket the storefront accepts; the seeded Owner in the gate check has a random password; the gate check now proves settings do not leak. One flaky false positive in the gate check (a random request ID containing "4900") was fixed by matching the price as data.

Not covered: WhatsApp links opening the app; the mobile menu sheet (not built); real content sections (step 97); real mobile touch testing; staging. Contact copy and WhatsApp wording are placeholders (BI-01, BI-09).

## Step 65 — guest customers, addresses and phone identity (2026-10-11, local)

`pnpm verify -- --integration`: exit 0. Unit 496 (domain 121), integration 369 (db 70), gateway 29, age-preview 1847, gate 1803. The run before it stopped at `test:int` with two API tests failing to get a database connection in time (`health.int.test.ts` readiness 503, `inventory.int.test.ts` "Unable to start a transaction in the given time"); neither touches this step's code and the immediate rerun passed. Not investigated further.

**Unit (`customer.test.ts`):** ten ways of typing one UAE mobile give one E.164 value; landline and foreign numbers with a country code; sixteen refused inputs (short, long, no country code, toll-free, extra text, non-string); name and text-line bounds, control and zero-width characters.

**Integration (`customers.int.test.ts`, real PostgreSQL, isolated schema, 11 tests):**

- Both tables start empty; exact column lists (no credential, email or session column).
- Database refuses: a phone not in E.164 shape, a duplicate phone, an untrimmed or empty name, a phone change, a version decrease, changing `first_order_at` once set, bad address type/empty fields/Makani not 10 digits, an unknown area, any address UPDATE, and deleting a customer or an area that has an address.
- Five typed forms of one number resolve to one customer; bad input writes nothing; the primitives refuse to run outside `withTransaction`.
- Eight concurrent first orders of one phone create exactly one customer; a second transaction waits for the first one's commit; a rolled-back transaction leaves no customer.
- First-order time is stamped once; an identical address is reused, a changed one is a new row, and renaming the customer leaves address rows unchanged.
- Runtime role: no DELETE/TRUNCATE on either table, no UPDATE on addresses (runs where `ih_app` exists; required in CI).

**`invariant-reviewer`:** no blockers. Done: zero-width/invisible characters refused and a name needs a letter or digit; call-order and caller rules documented on the primitives; version cannot decrease. Left as documented limits: trunk zero after a non-UAE country code; display name follows the latest typed name.

Not covered: "old snapshots independent" end to end, because order tables arrive in step 73 (what exists is checked: immutable addresses, no cascade, no delete); address saving against concurrent area/setting edits (step 75); the migration on the dev database (not applied).

## Step 66 — checkout input validation (2026-10-11, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 509 (domain 123, contracts 65), integration 371 (db 72), gateway 29, age-preview 1847, gate 1803.

**Unit (`customer.test.ts`, `order-lines.test.ts`, `checkout.test.ts`):**

- Phone: ten spellings of one UAE mobile give one value; landlines, foreign numbers, toll-free and malformed input are refused.
- Contact: both fields reported together with the form's wording; unknown fields and oversized input refused.
- Address: normalized output fits the storage bounds of step 65; a unit is required for an apartment and an office, not for a villa; all seven fields reported in one pass; bounds accepted exactly; Makani must be 10 digits (spaces and Arabic-Indic digits accepted); `feeFils`, `emirate` or any other extra field is refused.
- Lines: repeats merged and sorted; empty, 51 lines, quantities 0, −1, 1.5, 11, NaN, 1e21, 2^53 and a string are refused; two lines of one variant that together exceed 10 are refused; a line carrying `priceFils` is refused.
- The device cart's limits equal the server's.

**Integration (`customers.int.test.ts`, real PostgreSQL):** an active area is accepted; an inactive, unknown or malformed area ID is refused the same way; deactivation takes effect on the next read; the validators' output is stored unchanged by the step-65 customer primitives.

**`invariant-reviewer`:** no blockers. Done: a malformed area ID no longer reaches the database; Arabic-Indic digits accepted in the Makani number; villa-with-unit intent tested. Kept on purpose and recorded in ADR 0035: any `5x` mobile prefix is accepted.

Not covered: these rules behind a real route or in the checkout form (steps 71, 77); real areas (BI-03); a concurrent area deactivation during an order (step 75).

## Business-input fixes — final prices and UAE-wide delivery (2026-10-12, local)

`pnpm verify -- --integration`: exit 0. Unit 510, integration 371, gateway 29, age-preview 1847, gate 1803. The first run stopped at `test:int`: `catalogue.int.test.ts` still expected the database to refuse publishing without a tax reference; the test was updated to the new rule and the rerun passed.

- **Final prices (BI-02):** a complete product with no tax reference reports ready and publishes through the API (`publication.int.test.ts`); the database still refuses a published product with a zero price, a trashed one, or a disposable without a puff count (`catalogue.int.test.ts`); the missing-requirements list no longer contains `tax_treatment`.
- **UAE delivery (BI-03):** the flat fee applies in each of the seven emirates and a non-UAE or differently spelled emirate is refused (`delivery.test.ts`); an area can be created in Sharjah through the API, its emirate cannot be changed afterwards, and the database refuses an unknown emirate; the contract refuses an unknown emirate (`delivery.int.test.ts`).
- **Dev database:** `pnpm db:migrate` applied every migration, including the two new ones.
- **`invariant-reviewer`:** no blockers; the single old publish check is matched exactly once by the migration, the other publish guards and the emirate immutability trigger are intact. Done: superseded notes on ADR 0015/0021 and the step-51 record.

Not covered: the admin delivery and product screens were not opened in a browser after this change (type-checked and built only); `scripts/browser-qa/qa.mjs` was edited but not rerun and still expects a disabled Publish button for its QA product; `scripts/check-gate-e2e.cjs` still seeds an unnecessary tax reference; storefront copy still says "Dubai" (demo copy, BI-01).

## Step 67 — integer pricing and discount allocation (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 521 (domain 135), integration 376 (db 77), gateway 29, age-preview 1847, gate 1803.

**Unit (`pricing.test.ts`):**

- Allocation: hand-worked cases add up exactly; equal fractions settle by position; exact where the product exceeds 2^53; zero weights and impossible amounts refused.
- Order totals: no discount; 15 % of AED 219.99 = AED 33.00 shared 13.50/19.50, delivery not discounted; seven half-up boundary cases (4.5 → 5, 2.5 → 3, 49.95 → 50, 49.35 → 49, 0.5 → 1, 0.4999 → 0, 0.0999 → 0); 100 % leaves only delivery; the largest order the caps allow (AED 5,000,000,000.00) stays exact.
- 2000 generated orders (fixed seed): line subtotals, shares and totals always add up, no share is negative or above its line, and the same input gives the same result.
- Seventeen kinds of bad input (float, zero or negative price, unmerged lines, out-of-range quantity, discount or fee, NaN, Infinity) throw.

**Integration (`pricing.int.test.ts`, real PostgreSQL):**

- The variant override or the product price is read, with versions; a price sent by the client is ignored; repeated lines are merged; totals match a hand calculation.
- Draft product, inactive variant, inactive brand, inactive category and unknown ID are refused and named; the other variant of the same product still prices.
- Quantity caps apply before any read.
- While an order holds the price lock, a price change, a brand deactivation and a category deactivation all wait; a second order of the same variants does not wait; after the edits commit the next order is refused.
- `TransactionRestartError` restarts the transaction and gives up after three attempts.

**`invariant-reviewer`:** no blockers; it traced every admin writer of price, variant state, publication and parent visibility and found each takes a row this lock holds, with no lock cycle, and could not construct an allocation counter-example. Done: the catalogue-moved case is now retried instead of surfacing as "retry exhausted"; allocation refuses an amount above the total weight.

Not covered: a product actually changing brand between the two lock statements (only the retry mechanism is tested); pricing behind a route; coupons and the real delivery fee (steps 68, 70).

## Step 68 — percentage coupons (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 527 (domain 141), integration 387 (db 88), gateway 29, age-preview 1847, gate 1803.

**Unit (`coupon.test.ts`):** code normalization and nine refused forms (two codes, a list, full-width letters, too short or long); each rejection reason in its fixed order; exclusive expiry to the millisecond; minimum tested before the discount; half-up discount and percentage bounds.

**Integration (`coupons.int.test.ts`, real PostgreSQL, 11 tests):**

- Database shape: lower-case or malformed code, percentage outside 1–10,000, negative minimum, zero limit, duplicate code, code change, version decrease, expiry before start, and any direct write of the use count (on insert or update) are refused.
- One typed code in any case gives the half-up discount; a preview records nothing.
- Unknown, malformed, inactive, not started, expired, below minimum and full coupons are rejected with the right reason and store code; expiry follows the database clock.
- A use is recorded with its snapshot; the same order cannot redeem again with the same or another coupon; a later edit of the coupon does not change the snapshot; a redemption row cannot be altered.
- Eight orders racing for three uses: exactly three succeed, five get `LIMIT_REACHED`, the count is 3; a direct insert past the limit is refused by the database.
- Five concurrent releases of one order release once; the use is freed for the next order; a released row cannot be released again or revived; the released order cannot redeem again; the count matches the rows.
- A failed order rolls back its use; a previewed, altered or previous-transaction coupon cannot be redeemed; the primitives refuse to run outside `withTransaction`.
- An Owner edit waits for an order holding the coupon lock.
- Runtime role: no UPDATE/DELETE/TRUNCATE on either table as a whole; column-level UPDATE on the editable terms and on `released_at` only.

**`invariant-reviewer`:** no blockers. Done: redemption is bound to the coupon locked in the same transaction; the trigger is SECURITY DEFINER and the runtime role lost the right to write the use count, identity or redemption history; the rejection reason was removed from the contracts.

Not covered: the last part of the runtime-role test (insert, refused direct count write and release while acting as `ih_app`) returns early on this machine because the test role cannot assume `ih_app`; CI runs it. Coupons behind a route or in the Owner screen (steps 69–71); release from a real cancellation (step 86).

## Step 69 — Owner coupon administration and the Discounts screen (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 534 (admin 50), integration 394 (api 244), gateway 29, age-preview 1847, gate 1803. An earlier run stopped at lint on an unused variable in the new test.

**Integration (`coupons.int.test.ts`, real API and PostgreSQL, 7 tests):**

- Starts empty; all five routes answer 403 to Staff and 401 signed out; the repository refuses a missing actor.
- Create stores the code in capitals, answers `no-store`, and writes exactly one audit entry and one `coupon.updated` event; the same code in another letter case is `DUPLICATE`.
- Eighteen invalid bodies are 400 and store nothing: bad code, percentage 0, above 100 %, fractional or text, negative or fractional minimum, zero limit, bad date, end not after start, and `amountFils`, `brandId`, `type`, `activeRedemptions`. An active coupon that already ended is `ALREADY_EXPIRED` by the server clock; a coupon that ran out on its own can still be edited.
- Edit: new version, status recomputed; a stale version is `VERSION_CONFLICT` and changes nothing; saving the same values writes nothing; the code cannot be edited; unknown ID is 404; two audit entries and events for two changes.
- With two uses held by orders, lowering the limit to 1 is `LIMIT_BELOW_USES`, to 2 is accepted and shows "used up"; the use count cannot be sent.
- Trash: deactivates, hides from the live list, lists under Trash, keeps the code reserved, makes the coupon unusable for an order; the database refuses an active trashed coupon; restore returns it inactive; no delete route.
- Paging: newest first, bounded limit.

**Unit (`coupons.test.ts`, admin):** percentage text to basis points without floating point (including 0.07 → 7) and nine refused forms; local date round trip; create and update commands; the summary sentence.

**Real browser through the real gateway (headless Chromium, QA backend on an isolated schema, 16 checks, screenshots reviewed at 1366 px and 360 px):** Owner sees Discounts; empty state; a percentage above 100 is refused in the form; a code is created in capitals with the right sentence and "Live"; an edit shows version 2 and "Inactive"; a duplicate code shows its message; Move to Trash, the Trash tab, and Restore as inactive (version 4) work; no page errors or unexpected failed requests; no horizontal overflow at 360 px; Staff has no Discounts link and sees "Access unavailable" at the address.

**`invariant-reviewer`:** no blockers; permission seeds, audit/outbox atomicity, version handling, lock order and input validation confirmed. Done: `ALREADY_EXPIRED` no longer blocks unrelated edits of a coupon that ran out; the table check on the limit maps to `LIMIT_BELOW_USES` instead of a server error.

Not covered: dark theme and real mobile touch on this screen; two Owners editing at once in the browser (covered at the API); coupons in the store (steps 70–71).

## Step 70 — delivery fee and quote assembly (2026-10-12, local)

`pnpm verify -- --integration`: exit 0. Unit 534, integration 401 (db 100, api 245), gateway 29, age-preview 1847, gate 1867 (the new store route is in the refused list).

**Integration (`quote.int.test.ts`, real PostgreSQL, 6 tests):**

- No quote before the Owner configures delivery; an inactive area is still reported as unavailable.
- A quote from server state only: merged lines, variant override or product price, 15 % of AED 219.99 = AED 33.00 shared 19.50/13.50, AED 15.00 delivery, total AED 201.99; area, configuration, product, variant and coupon versions present; a price and a fee sent on a line are ignored; a preview uses no coupon; a blank code means no coupon.
- The same flat fee for a AED 1.00 order and a AED 10,000,000,000.00 order; the database refuses a free-delivery threshold.
- Lines that cannot be filled are named; no stock movement is written and stock is unchanged.
- A closed, unknown or malformed area, an unknown variant, an empty cart, a quantity of 11 and an unknown code each fail the whole quote; a coupon minimum is tested on merchandise before the discount.
- Under locks the order gets exactly the preview's numbers; while it is open a fee change, an area deactivation, a price change and a coupon edit all wait; afterwards the closed area and the used-up coupon refuse the next quote, and a new quote shows the new fee, price and versions.

**Integration (`store-catalog.int.test.ts`):** `GET /v1/store/delivery` is empty and unconfigured at first; then lists only active areas by emirate and name with the fee and ETA, with no code, version or staff field; an area switched off disappears from the next answer; an unverified request is 403.

**`pnpm test:gate`:** the new route refuses the eight kinds of unverified request, cold and warm.

**`invariant-reviewer`:** no blockers; lock order, client-input isolation, free-delivery handling and the refactor of `lockDeliverySelection` confirmed. Done: a named `QuoteInvariantError`; comments on the caps.

Not covered: a quote through a route, its fingerprint and expiry (step 71); stock consumption (step 76).

## Step 71 — signed quote and price acceptance (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, three times (before the browser pass, after a layout change, after the review fixes). Unit 548 (platform 84, storefront 97, config 31), integration 407 (api 251), gateway 29, age-preview 1847, gate 1928.

**Unit:** fingerprint stable across line order and ID case and different for twelve kinds of change; token verifies until its expiry second, survives key rotation, and is refused when its expiry, fingerprint, signature, key or format is altered; `checkAcceptedQuote` accepts only unchanged facts in time (one fil either way is a change). Config: keys optional locally, purpose-bound, required in staging and production. Storefront: request key, the three comparison outcomes including a server-dropped code, when the shopper may proceed, the message for each API answer.

**Integration (`cart-quote.int.test.ts`, real API and PostgreSQL, 6 tests):**

- Four kinds of unverified request get 403 with no price, ETA, code or ID; a verified request without an Origin, from another site's Origin or marked cross-site is 403.
- A quote for two lines with a code: the server's totals, the area, the coupon, the short line named; no version, product ID, coupon ID, area code or SKU in the body; the token verifies with the service's key and lasts about 900 seconds; the same cart gives the same fingerprint; nothing is reserved or recorded.
- Order-time decision under locks: accepted when unchanged; still accepted after a description edit; `QUOTE_CHANGED` after a price drop of one fil and after a fee change; a new quote then shows the new total and a new fingerprint.
- Twenty invalid bodies are 400, among them a client total, fee, discount, unit price, a list of codes and over-cap quantities.
- Closed and unknown area, draft and unknown variant, unknown and inactive code, used-up code: one stable 409 code each, with no product name, ID or detailed reason.
- The 31st quote in a minute from one address is 429.

**`pnpm test:gate` (real API, storefront and gateway container):** the quote POST is refused for all eight kinds of unverified request, cold and warm, with no price, fee or product data; a verified quote through the gateway is 200 with the server's arithmetic (2 × AED 49.00, 10 % off, AED 15.00 delivery = AED 103.20), a signed token and `private, no-store`; a client total or price is 400; a draft product is `VARIANT_UNAVAILABLE` and not described; a missing or foreign Origin is refused; the delivery choices are exactly the active area, fee and ETA.

**Real browser through the real gateway (headless Chromium against `test:gate -- --serve`, 23 checks, screenshots reviewed):** area list grouped by emirate; no total before an area is chosen; subtotal, delivery and total from the server; a quantity change re-prices (four quick taps cause one request); a valid code shows the discount and new total; after the fee is changed in the database, asking again announces "Your total changed from AED 103.20 to AED 108.20" and is not confirmed until "Accept new total"; after the accepted code is switched off, the higher total is announced and needs acceptance; an unknown code shows its message and the total without it; more than the stock is named and not confirmed; a closed area shows its message and no total; nothing about the quote is in localStorage or sessionStorage; no page errors; no overflow at 360 px.

**`invariant-reviewer`:** no blockers. Done: a total that rises because the server dropped an accepted code now needs an explicit accept (found by the review, then confirmed in the browser); the "working" text no longer sticks when the request is withdrawn; the shared-key requirement for replicas is documented.

Found by this step's own browser run: the expected amounts in the check script assumed two decimals where the storefront prints "AED 49"; the page was right and the script was corrected.

Not covered: the order using the token (step 76); token expiry in the browser (15 minutes; covered in unit and API tests); dark theme and real mobile touch; a stricter limit for failed coupon attempts.

## Step 72 — pricing and promotion acceptance pass (2026-10-12, local)

`pnpm verify -- --integration`: exit 0. Unit 548, integration 414 (api 258), gateway 29, age-preview 1847, gate 1928. No production code changed in this step.

**`apps/api/src/store/pricing-acceptance.int.test.ts` (real API and PostgreSQL, 7 tests).** The Owner configures areas, the fee, products, variants, stock and coupons through the admin API; a shopper is quoted through the store API; "an order" is the order transaction's quote step (`lockQuoteForOrder`), because order placement arrives in M7. Products are published by a direct write with a directly inserted ready image (publishing through the API needs the media pipeline and is covered by the publication and media tests).

| Case     | Shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PRICE-01 | Four lines over three variants merge to three; 15 % of AED 286.65 = AED 43.00 (half-up from 42.9975), shared 19.50 / 13.50 / 10.00 and adding up exactly; the same cart in another order gives identical lines and fingerprint; every amount is a safe integer; no tax field anywhere; quantities over 10 (also split over lines) are 400. The largest order the caps allow (AED 100,000,000.00, 33.33 % off) is exact; a price above the cap cannot be entered.                                                   |
| PRICE-02 | Four order transactions race for a coupon's single use: one succeeds, three get `COUPON_LIMIT_REACHED`; the Owner's list shows 1 use and "used up"; a shopper is told the same; three concurrent releases release once and the next shopper can be quoted with the code; counts match the rows.                                                                                                                                                                                                                    |
| PRICE-03 | Not started, inactive, ended (by the database clock) and unknown codes are `COUPON_INVALID`; the minimum is on merchandise before the discount and delivery does not count; a list of codes, a second code field, a client discount, percentage or total are 400; a fixed amount, a brand or product scope and a stacking flag cannot be created.                                                                                                                                                                  |
| PRICE-04 | The same AED 15.00 fee in two emirates and for a larger order, with a null free-delivery threshold; a threshold cannot be configured (400); shoppers are offered active areas only; an inactive or unknown area is `AREA_UNAVAILABLE`; closing an area removes it from the list and refuses the next quote; reopening restores it.                                                                                                                                                                                 |
| PRICE-05 | After a quote, a price rise, a price drop, a fee change and a coupon percentage change (each through the admin API) make the order-time decision `QUOTE_CHANGED`; a fresh quote has a new total and fingerprint and is accepted; restoring the value makes the original quote acceptable again. Another area at the same fee, a removed code and a changed quantity are also `QUOTE_CHANGED`; a closed area ends the order; an old token is `QUOTE_EXPIRED`; a token for a cheaper cart does not fit a larger one. |
| M6 gate  | Twenty shoppers quoted the last unit at once all get the total; asking for three of one unit is priced and named as short; stock, the stock ledger and the coupon's use count are unchanged.                                                                                                                                                                                                                                                                                                                       |
| PRICE-06 | Not applicable: prices are final as entered and there is no tax calculation (ADR 0036). `docs/acceptance.md` updated.                                                                                                                                                                                                                                                                                                                                                                                              |

Found while writing this pass: my first hand-worked discount shares for PRICE-01 were wrong (19.49 instead of 19.50); the calculation in the product was right and the expected values were corrected after redoing the arithmetic. The admin API refuses to edit a variant of a product that would not be publishable (`PUBLISH_REQUIREMENTS`), so test products need a ready image; that rule is existing behaviour (ADR 0021).

`invariant-reviewer` was not run for this step: it adds a test and documentation only.

**M6 gate — "a cart has a trustworthy server quote; stock is not yet reserved for a cart".** Evidence: this pass; `cart-quote.int.test.ts`; `pnpm test:gate` (the quote through the real gateway, 1928 checks); the 23-check browser pass of step 71. Caveats: products in these checks are seeded or published by a direct write; the Owner has not entered real areas, a fee or coupons; the order that consumes a quote does not exist yet. The gate decision is Marina's.

## Step 73 — order, line and status-history schema (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 550 (domain 144), integration 426 (db 124), gateway 29, age-preview 1847, gate 1928. An earlier run stopped at lint: the new test fixture used `Math.random`, which this project forbids; it now uses `node:crypto`.

**Unit (`order-status.test.ts`):** the display number formats and reads back (`IH-001001`, typed forms, refusals); only a staff-entered order may start confirmed; edits only while pending or confirmed.

**Integration (`orders.int.test.ts`, real PostgreSQL, 11 tests):**

- Tables start empty; orders are numbered 1001, 1002; the number cannot be chosen or changed.
- After the customer is renamed, the product renamed and repriced, the variant's SKU and price changed and the area renamed, the order and its line are unchanged; the customer, variant, product and area cannot be deleted.
- All 30 pairs of statuses: the database accepts exactly the eight the domain allows. A delivered order has five history rows at versions 1–5 and its cash is still pending.
- A status change without its history row, a history row for a status the order is not in, history that does not continue, a second way out of a status, a repeated command, and any history update or delete are refused. A store order cannot be slipped in as confirmed, cancelled or later through its first history row.
- A cancellation needs a reason, a history reason and `not_collected`; cancelled is final.
- While pending the address and the lines (with matching totals) can change; once processing, seven kinds of content change, line changes, line deletes and line inserts are refused, as is a content change in the update that starts processing. Identity changes and any version step other than +1 are refused at every stage.
- Money: eight inconsistent order totals and seven inconsistent line amounts are refused; a discount is accepted only when order and lines change together; one line per variant.
- Cash can be recorded only for a delivered order with amount, time and person; a cash record, delivery time, dispatch time, cancel reason and cancel time cannot be rewritten; a pending order cannot carry a dispatch time; a delivered order cannot be cancelled.
- An order cannot be deleted even by the schema owner.
- Incomplete or disallowed orders are refused: store order starting confirmed, manual order without an operator, unknown source, no lines, a reused creation key, ten malformed fields, a duplicate confirmation verifier.
- Runtime role: no DELETE/TRUNCATE on the three tables, no UPDATE on history; it can insert an order and gets a number without a sequence grant (the insert part runs in CI).

**Existing tests** that recorded coupon uses now use real orders through the `seedOrder` fixture; a use for an order that does not exist is refused.

**`invariant-reviewer`:** two blockers and five should-fixes, all fixed before commit. Blockers: a NULL made the history check accept a first row of any status; and a store order could become confirmed with a single "creation" history row. Should-fixes: recorded cash, delivery and cancellation fields could be rewritten; contents could change in the same update that started processing; two writers could fork the history; an unchanged version was accepted; a pending order could carry a dispatch time. Each has a test above.

Not covered: these rules exercised by a real order command (step 76 onward); the migration on a database with existing coupon uses (there is none anywhere). The dev database has the migration applied.

## Step 74 — idempotent commands (2026-10-12, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 550, integration 439 (db 137), gateway 29, age-preview 1847, gate 1928. An earlier run stopped at typecheck on the new test file.

**Integration (`idempotency.int.test.ts`, real PostgreSQL, 13 tests):**

- Payload hash: the same request in another field order hashes the same; four kinds of change hash differently; `undefined`, an array hole, a prototype-less object, a float, NaN, a date, a function and a bigint are refused.
- Keys: only 22–128 URL-safe characters; the hash is bound to the scope.
- A command runs once; three more calls with the same key and payload replay the stored answer; the record lasts 24 hours by default; the key is nowhere in the table.
- A different payload on the same key is a conflict, runs nothing and leaves the first answer; the same key in another scope is independent.
- A failing command leaves no record and the key works again with a corrected payload.
- **Waiting, observed in `pg_stat_activity`:** a second request waits on the first one's uncommitted claim; when the first rolls back the waiter runs as the owner; when the first commits, a waiter with the same payload replays and one with a different payload conflicts.
- Eight simultaneous identical requests run the command once; two different requests on one key: one wins, one conflicts.
- A request that waits longer than its bound gets `IDEMPOTENCY_IN_PROGRESS` in under two seconds and replays after the first commits; a lock timeout set earlier in the transaction is put back after the claim.
- A claim without an answer cannot commit; an answer is written once; the claim refuses to run outside `withTransaction`.
- After expiry the key is refused with `CHECKOUT_RECOVERY_REQUIRED` and the order it created, runs nothing, and still conflicts for a different payload; an unexpired record cannot be deleted; cleanup removes the expired one.
- Key, payload, scope, expiry and answer cannot be changed afterwards; an oversize answer, malformed hashes and scopes, a non-object answer, a short payload hash and a malformed key are refused; a nonsense wait or lifetime falls back to the bounds (60 seconds, 30 days); runtime role has no TRUNCATE.

**`invariant-reviewer`:** no blockers; it confirmed the `ON CONFLICT DO NOTHING` claim is correct in every interleaving under Read Committed. Done: the previous lock timeout is restored instead of reset; a NaN wait no longer breaks the statement; array holes are refused; the concurrent rollback and commit cases are tested with real waiting; weak assertions replaced. Documented instead of changed: keys are checked for shape only, so answers must hold nothing sensitive; step 76 must look up the order's own key hash after the claim. Not changed: the trigger functions rely on the connection's schema like every other trigger in this project.

Found by this step's own run: a check that put its assertion inside a callback whose error was swallowed; it was rewritten so a failure fails the test.

Not covered: a real command using the claim (step 76); the HTTP mapping (step 77); the scheduled cleanup. The dev database has the migration applied.

## Step 75 — canonical lock order (2026-10-12, local)

`pnpm verify -- --integration`: exit 0 on four of five runs. Unit 550, integration 445 (db 143), gateway 29, age-preview 1847, gate 1928. One run stopped at `test:int` with `settings.int.test.ts` failing on "Connection terminated due to connection timeout"; that test passes alone and passed in the other runs. This is the second connection-timeout failure of an API integration test under the parallel suites (the first was in step 65). Not fixed: the integration suites of four packages run at the same time against one PostgreSQL with 100 connections.

**Integration (`order-locks.int.test.ts`, real PostgreSQL, 6 tests):**

- An order creation walks idempotency → order → customer → delivery → catalogue → coupon → variants and returns the customer, the quote (hand-checked total) and the variants with their stock.
- All 21 pairs "earlier group after later group" throw `LockOrderError` naming both; the same group twice and skipped groups are fine; inside the refused transaction the customer the refused step would have created does not exist; outside a unit of work the primitives refuse.
- An address is saved after the area lock for a customer the transaction holds; on its own it takes the customer lock itself; for an unlocked customer after the area lock it is refused; after an address was saved first, the delivery selection is refused; the first-order stamp needs the customer lock.
- Variants are locked in ID order whatever order they are asked in: while one transaction holds the larger ID, another asking for [larger, smaller] already holds the smaller (a NOWAIT probe is refused) and waits for the larger. Unknown variants are named; an empty request locks nothing.
- Two commands on one order run one after the other (the second is seen waiting); an unknown order is a typed error.
- Thirty order walks, half listing the variants in each direction and all sharing a coupon, race seven admin lock sequences written as the admin code locks them (parents → product → variants, a brand, the fee, the area, the coupon, a stock adjustment), each in one unretried transaction: no error of any kind, and every order walk ran exactly once, so none was ever a deadlock victim.

**Existing tests** updated for the stricter rules: a coupon release now locks its order first, and is refused without it.

**`invariant-reviewer`:** no blockers and no deadlock cycle found across the order walk, the planned order inserts (foreign keys and triggers) and every admin writer. Done: the three unenforced rules above (address before delivery selection, first-order stamp, coupon release) are now checked; malformed IDs are typed errors; the check that "a refused step ran no statement" now looks inside the transaction; the stress test, which could not have detected a deadlock, was replaced by the one described above.

Not covered: these locks under a real order creation (step 76); the staff row for staff-entered orders.

## Step 76 — atomic order creation (2026-10-13, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 550, integration 458 (api 271), gateway 29, age-preview 1847, gate 1928. Docker Desktop stopped twice during this step and was restarted (the machine had about 5.5 GB of free disk); runs that failed only because PostgreSQL was unreachable are not counted.

**Integration (`create-order.int.test.ts`, real API services and PostgreSQL, 13 tests):**

- **One order writes everything together:** a two-variant order with a 10 % code (AED 219.99 − 22.00 + 15.00 = AED 212.99): the order row with every snapshot field, two merged lines with their discount shares, one history row, two `SALE` movements and the new balances, the coupon use and its count, the customer, the saved address and first-order time, one audit entry, `order.created` and `inventory.low` for the line that crossed its threshold, one idempotency record. Counted before and after: exactly those rows. The answer is order number, total and time only; the audit entry and the order row contain no phone, name, address, key or token.
- **Replay and conflict:** the same attempt again (once, and five at once) returns the same answer and writes nothing; a changed quantity, name, address or coupon on the same key is a conflict; six simultaneous copies of one attempt make one order.
- **Last unit:** eight shoppers race for one unit: one order, seven `INSUFFICIENT_STOCK` naming the variant, stock 0, and the seven left no customer, address or record; a loser's key works again after a restock.
- **Last coupon use:** five orders race for a single use: one gets it, four get `COUPON_LIMIT_REACHED`, and only the winner took stock.
- **Changed total:** after a price rise or drop the order is `QUOTE_CHANGED`; a forged token, an altered one, one for another cart and one with a changed expiry are refused; a hidden product, a closed area and a quantity above stock are refused; each time the row counts and stock are unchanged; the same key then succeeds once the total is right.
- **Tokens:** an expired genuine token and a token signed with an unknown key cannot place a new order; a retry of a placed order with an expired token still gets its answer.
- **Stock rules:** only the short line is named when one of two is short; a variant switched off after the quote is not sold even with stock; in the database a sale without an order, a restock pointing at an order, a sale that adds stock, a sale with a foreign command ID and a second sale of one variant for one order are refused; staff see the sale in the variant's ledger.
- **No deadlock:** sixteen orders listing two shared variants in opposite orders, all with one coupon, race six stock adjustments made through the admin function: no failure, and stock and coupon counts are exact.
- **Rollback:** with the last write of the transaction (the outbox event) made to fail, nothing remains (no order, stock movement or coupon use) and the same attempt then succeeds.
- **Old keys:** after the stored answer expires, and after it is deleted, the same key is refused with `CHECKOUT_RECOVERY_REQUIRED` naming the order, and no second order is made.
- **One customer per phone:** three orders from one phone share a customer; the display name follows the latest order while each order keeps the name it was placed with; the same address is saved once.

**`invariant-reviewer`:** no blockers; atomicity, money, lock order, the stock rules and personal data confirmed. Done: forged tokens are refused before any database work; the variant version is re-checked under the lock; the order takes the customer snapshot from the locked row; seven named test cases added.

Found by this step's own run: the service threw one refusal synchronously instead of returning a rejected promise; it is now `async`.

Not covered: placing an order over HTTP (step 77); the second 18+ confirmation as an input (required by the step-77 contract); notifications and the confirmation cookie (steps 78–79). The dev database has the migration applied.

## Step 77 — store order route, limits and outage fallback (2026-10-13, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 554, integration 469, gateway 29, age-preview 1847, gate 1978.

**Integration (`store-orders.int.test.ts`, real API over HTTP and PostgreSQL, 10 tests):**

- **Placing:** a two-unit order with a 10 % code answers 201 with the order number, total (AED 159.00) and time only, `private, no-store`, no cookie; one order, sale, coupon use, customer, idempotency answer and event are written; the stored order carries the age policy version.
- **Switched off:** with `CHECKOUT_SUBMISSION_ENABLED` unset a valid, age-verified order answers 503 and writes nothing.
- **Age and Origin:** no ticket (also with a crawler user agent) is 403 `AGE_VERIFICATION_REQUIRED`; no Origin, another Origin and a cross-site request are 403; nothing is written.
- **Invalid input:** a bad name, phone and unit name their paths with the fixed text and do not echo the typed phone; `ageConfirmed` false or missing, a client total, a client line price, no lines, an empty token, and a missing, short or malformed `Idempotency-Key` are 400.
- **Retry and conflict:** the same key and request (spelled differently, from another address) returns the same answer; two at once make one order (the loser gets the same answer or `IDEMPOTENCY_IN_PROGRESS`); another quantity on the same key is `IDEMPOTENCY_CONFLICT`.
- **Old key:** after the answer expires and after the cleanup function removed it, the key answers `CHECKOUT_RECOVERY_REQUIRED` without the order ID or number and makes no order.
- **Refusals:** `QUOTE_CHANGED` (price moved, token not ours), `QUOTE_EXPIRED`, `INSUFFICIENT_STOCK` (no variant ID in the body), `VARIANT_UNAVAILABLE`, `AREA_UNAVAILABLE`, `COUPON_INVALID`; row counts and stock unchanged.
- **Attempt limits:** the sixth attempt a minute for one phone and the eleventh for one address are 429 with `Retry-After`, refused attempts counted; a real order from the limited address is refused and not written; quotes from it still work.
- **Code guessing:** four refused codes at checkout plus six on the cart spend the budget; good codes in between use none; afterwards a right code and a wrong one both get 429 on both routes, an order with a code is refused and not written, an order without a code is placed, and another address is unaffected.
- **Shared limiter down** (replicated profile, unreachable Redis): an order and its retry are placed, the third attempt for that phone is 429, and after five refused codes no code is looked at.

**Other tests:** limiter `peek` (local, overflow partition, endpoint, outage and fail-closed in `rate-limit.test.ts`; Redis in `security.int.test.ts`); the quote limit test now shows ten refused codes, then 429, and thirty priced quotes a minute. `pnpm test:gate`: an order POST without a ticket is 403 for every attempt type, and a verified one is 503 with no order row while submission is off.

**`invariant-reviewer`:** no blockers. Done: every coupon refusal counts; a failed count cannot replace the answer. Recorded in ADR 0046: the code budget can be exceeded by one simultaneous burst (bounded by the per-minute address limits); limits run before the replay.

Not covered: a burst of simultaneous wrong codes; the `idempotency.cleanup` job wrapper; a browser flow (no checkout form until step 80). Limit values are not measured capacity (M11).

## Step 78 — new-order inbox notification and email (2026-10-13, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 554, integration 476, gateway 29, age-preview 1847, gate 1978.

**Integration (`order-notifications.int.test.ts`, real PostgreSQL through `EffectRunner`, 7 tests):**

- A new `order.created` event carries exactly the `notification` and `email` effects.
- **Inbox:** one notification ("New order IH-…", "3 items · AED 165.00 · area", link `/orders/<id>`) with receipts for the active Owner and Staff users, none for a deactivated user or a role without `notifications.read_own`; a second delivery is a duplicate; no customer name, phone or address in it.
- **Redelivery:** content stays as first written, one user's read flag survives and another's stays unread, a newly eligible user gets one receipt, nobody gets two. The database refuses changing or deleting a notification, un-reading or moving or deleting a receipt, and an absolute URL as a link.
- **Inbox off:** nothing is written and the effect completes.
- **Email:** nothing is sent while unconfigured or disabled (`no-recipients`); when enabled, one message to the listed addresses with the order number and AED 115.00 in the subject, item count and area in the text, and no customer data, order ID or link; a second run is a duplicate.
- **No email dependency:** with a failing provider the email effect is `retry`, the inbox entry is written, the order is untouched and the stored error holds no address.
- An event without an order goes to `dead` with `ORDER_NOT_FOUND`.

**Other tests:** an order placed over HTTP (`store-orders.int.test.ts`) leaves both effects pending with its event; the catalogue test lists `notification` among wired consumers; two tests that used `order.created` as an event without consumers now use `order.updated`.

**`invariant-reviewer`:** no blockers. Done: column-level `UPDATE (read_at)` for the runtime role; ADR notes on retention and on re-checking permissions in step 91.

Not covered: sending this email through Mailpit or Resend (stub adapter here); reading the inbox (step 91); the worker process picking the effects up from the queue end to end (the M7 gate, step 82).

## Step 79 — private confirmation cookie/API and replay expiry (2026-10-13, local)

`pnpm verify -- --integration` PASS, exit 0: production builds, format/lint/typecheck, unit 562, integration 482, gateway 29, age-preview 1847, gate 1978, boundary/infra/reference/contract checks. Eight new unit tests cover independent 256-bit capabilities, authenticated encryption/AAD tampering, key rotation/retirement, exact/canonical separate-purpose keys, deployed checkout key requirements, strict cookie parsing/duplicate denial and non-extending secure cookie attributes. Six new real Nest/PostgreSQL tests extend the order-route suite (16 tests; combined with 13 creation tests, targeted 29 PASS).

API tests prove private snapshots only with the capability cookie (no age/admin credential substitution), no customer identity/phone/notes/internal IDs in confirmation or raw capability in replay JSON/ciphertext, hashed verifier/30-minute expiry, same cookie restored on retry, malformed/forged/duplicate/URL-only denial, strict unknown-query rejection, independently scoped orders, per-address 60-read budget, unexpired ciphertext mutation refusal, expired private access denied, ciphertext erased while success remains replayable with no new order/effects, no material reattachment after clearing, and restoration across a fresh API/key rotation. Retiring the decrypt key still replays sanitized success without minting access or repeating writes. Existing creation rollback/concurrency/24-hour expiry/cleaned-key guards pass.

Initial integration exposed Prisma BYTEA returning Uint8Array rather than Buffer and loss of PostgreSQL expiry microseconds through JS Date. The repository now normalizes bytes and copies expiry directly within SQL. Strict-query DTO wiring, obsolete no-cookie/null-verifier expectations, synthetic clock fixture bounds and test response typing were corrected before the final green run. Expiry fixtures alter guards only in disposable schemas and restore them in finally blocks. Final independent invariant review: no issues; exact/canonical AES key validation finding fixed and tested.

No live migration, `.env` reads/edits, real keys/identities/emails or M7 gate closure. Additive migration was exercised only in isolated test schemas. The new cleanup function is exercised against real PostgreSQL; its scheduled worker process and cookie behavior in a browser through the real gateway are not independently demonstrated in this step. Existing gateway/age-boundary suites pass; complete checkout/confirmation UI and worker/browser journey remain steps 80–82. Applied API/worker deployment requires the migration and managed API-only keys before enabling checkout. README/start/status/security references were refreshed to remove obsolete foundation-only claims.

## Step 80 — checkout form and attempt key (2026-10-13, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 573, integration 482, gateway 29, age-preview 1855, gate 2079.

**Unit (`lib/checkout/checkout.test.ts`, 11 tests):** the key is 256 random bits in the shape the API accepts and is stored with its time only; only an exact stored attempt is read back; the key is reused from storage, falls back to session storage, and lives on the page only when every store is blocked; the form reports every problem at once with the shared messages, a villa needs and sends no unit; API field names become messages without the typed values; a readable 201 is the only acknowledgement; in-progress, 429, 5xx and unreadable answers keep the key; an old or reused key is "already placed"; quote, stock, coupon, area and age answers map to their own outcome.

**Browser (`scripts/browser-qa/checkout.mjs`, headless Chromium at 360px, real API + storefront + gateway with checkout open, 21 checks, run twice):** the cart page offers checkout once a total is accepted and the area is carried over; no horizontal scroll; an empty form shows five messages and sends nothing; after typing, after a lost answer and after the order, device storage holds nothing that was typed; no key exists before the first attempt, then only `{key, createdAt}`; the cart is kept while the outcome is unknown; a reload empties the form and keeps the key; typing the details again and pressing the button returns the order with the same key (two POSTs, one order row); the key and the cart are cleared after the acknowledgement; the confirmation cookie is HttpOnly and Secure; nothing is put in the URL; an empty cart says so.

**Scripts:** `/checkout` is refused before the age check like every page; a verified shopper sees "Checkout is not open yet" while orders are off; with a stub API that reports open, the server-rendered frame carries no catalogue data and sets `no-referrer`.

**`invariant-reviewer`:** no blockers; four should-fixes done (see PROGRESS).

Not covered: a changed total, a sold-out line and the "already placed" screen in a browser; `CartQuote`'s accepted-total callback as a component test; real mobile devices; the confirmation page (step 81).

## Step 81 — order confirmation page (2026-10-13, local)

`pnpm verify -- --integration`: exit 0, twice (before and after the review fixes). Unit 577, integration 482, gateway 29, age-preview 2008, gate 2175.

**Unit (`lib/checkout/checkout.test.ts`, 4 more tests):** only a snapshot that matches the contract exactly is shown (an extra field such as a phone is refused); 401 is "expired", 429 and 5xx are "could not load"; the subtotal row is the API's total less delivery plus discount (AED 159.00 − 15.00 + 16.00 = 160.00); address lines, option text and UAE-time formatting; the acknowledgement is remembered as number, total and time.

**Browser (`scripts/browser-qa/checkout.mjs`, headless Chromium at 360px, real stack with checkout open, 28 checks, run twice):** the 21 checks of step 80, and: after the order the browser is on `/order-confirmation` with the order number, AED 64 to pay in cash, the next steps and the delivery address; the page shows no name, phone or delivery note; no horizontal scroll; no script or frame from another origin; a reload shows the order again; Back does not return to the checkout form; with the cookie removed the page says the order cannot be shown and shows no order detail. One order row from two submissions.

**Scripts:** `/order-confirmation` (also with `?order=…&phone=…`) is refused before the age check; for a verified shopper the server-rendered frame carries no order or catalogue data, nothing from its address, `no-referrer`, `noindex`, and nothing loaded from another origin.

**`invariant-reviewer`:** no blockers; the subtotal identity is guaranteed by the `order_total` database check.

Not covered: the expired state with the order remembered from this visit (needs the cookie to lapse without a reload); status lines other than "received"; real mobile devices.

## Step 82 — checkout correctness gate (2026-10-13, local)

`pnpm verify -- --integration`: exit 0. Unit 577, integration 489, gateway 29, age-preview 2008, gate 2175. Browser journey (`scripts/browser-qa/checkout.mjs`): 49 checks, all passed on the final code. **The M7 gate is not marked passed here; that is Marina's decision.**

**Gate items (roadmap row 82) and what proves each.** A = `apps/api/src/orders/create-order.int.test.ts` (order service, real PostgreSQL), H = `apps/api/src/orders/store-orders.int.test.ts` (real API over HTTP), W = `apps/worker/src/checkout-gate.int.test.ts`, B = browser journey.

| Item                  | Proof                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last unit             | A: eight shoppers race, one order, seven `INSUFFICIENT_STOCK`, stock 0, losers leave no row. H "gate: shoppers racing over HTTP": six requests, one 201, five 409, stock 0, exactly one order, sale, customer and stored answer. B: a line that sold out before the button was pressed is not ordered.                                       |
| Last coupon use       | A: five orders race for one use, one wins, four `COUPON_LIMIT_REACHED`, counts exact. Service level only.                                                                                                                                                                                                                                    |
| Duplicate lines       | H "gate: repeated lines": 2 + 3 of one variant is one line of five, one sale, AED 165.00; the same order written as one line replays the same answer; repeats cannot pass the per-item limit.                                                                                                                                                |
| Simultaneous same key | A: six copies at once, one order. H: two at once, one order, the loser gets the answer or `IDEMPOTENCY_IN_PROGRESS`.                                                                                                                                                                                                                         |
| Changed payload       | A and H: another quantity, name, address or coupon on a used key is `IDEMPOTENCY_CONFLICT`, no second order. B: a changed name after a lost answer shows "already placed" and places nothing.                                                                                                                                                |
| Lost response         | B: the answer is dropped after the shop placed the order; the key is kept, survives a reload, and the retry returns that order (three submissions, one order). H: the cookie is restored on replay; an expired key answers `CHECKOUT_RECOVERY_REQUIRED`. W: after the cleanup jobs ran, the same request is refused and stock is unchanged.  |
| Rollback              | A: the last write is made to fail and nothing remains, then the same attempt succeeds; every refusal test checks unchanged row counts and stock.                                                                                                                                                                                             |
| Limiter outage        | H: with the shared limiter unreachable an order and its retry are placed, the third attempt for that phone is 429, code guessing stops after five. H "gate: a burst of wrong codes": 25 at once are answered only "invalid" or "too many", then no code is looked at.                                                                        |
| Queue outage          | W "an unavailable queue costs no order": with nothing enqueueable the order is complete and both effects are untouched; when the queue returns, one notification and one email. `recovery.int.test.ts`: jobs lost in Redis are found again. H: the order route itself reaches no queue; its event and two pending effects are in PostgreSQL. |

**M7 gate line** (age → product → variant → cart → quote → COD order → private confirmation, with real PostgreSQL and worker effects):

- B, one run on the real API, storefront and gateway, with the worker's relay, queue Redis and consumers running on the same schema: the age check refuses the product address and shows nothing of the product; after accepting, the product page; a variant is chosen and added; the cart quotes a total; checkout places the order; the confirmation page shows it from the cookie; **the worker completes the inbox and email effects of both orders, one notification each, naming its own order.** Two journeys, two orders, stored at AED 64.00 and AED 66.00 (the totals their shoppers accepted), stock down by exactly what was sold, and the device holding only the cart and saved lists afterwards.
- W "M7 gate": an order placed by the real order transaction goes through the real relay, BullMQ and consumers; one notification with the Owner's receipt, exactly one message in Mailpit with the order number and AED 255.00 and nothing about the customer; duplicate deliveries of both jobs are run and change nothing.

**Not covered.**

- The browser journey is a local script: it is not part of `pnpm verify` or CI.
- In it the age answer is posted with the storefront's https Origin instead of clicking the button (the served storefront refuses the local http origin); the button is covered by the gate script and step 56.
- In the browser run the email goes to a stub adapter; delivery to Mailpit is shown in W, where the order is placed through the database function, not HTTP.
- A last-coupon race over HTTP; logs on the checkout path are not captured and searched for personal data; real mobile devices; staging.
- The cleanup-job test moves an answer's dates with the table's guard switched off; it shows the jobs remove what is past its expiry, not the passing of real time.

## Step 83 — admin order list, snapshot detail and history (2026-10-13, local)

`pnpm verify -- --integration`: exit 0. Unit 577, integration 493, gateway 29, age-preview 2008, gate 2175. Production builds, format, lint, typecheck, package boundaries, infrastructure/reference checks and generated OpenAPI all passed.

**API/PostgreSQL (`admin-orders.int.test.ts`, 4 tests):** anonymous access is 401 and removing the current actor's `orders.read` grant takes effect on the next request with 403; page size, status, time range, unknown query, UUID and opaque cursor bounds are strict; newest-first `(created_at,id)` keyset pages do not repeat a row; status and half-open date filters work; display-order-number and customer searches work. Detail returns the immutable customer/address, item, amount and append-only history snapshots after the live customer record changes, without customer/catalogue IDs, creation/idempotency hashes, quote/confirmation fields or command IDs.

Removing `customers.read` strips the entire customer object from list and detail through both repository authorization and the response field policy. A name query then returns no result while the display order number still works, so contact search cannot be used as an existence oracle. Both routes are `private, no-store`; detail reads items and history in one repeatable-read transaction. The generated OpenAPI covers both routes, and the migration adds the unfiltered/date-page `(created_at DESC,id DESC)` index.

**Admin UI:** the Orders workspace now has status tabs, order/contact search (order-number-only when contact permission is absent), placement date bounds, cursor paging, responsive rows and read-only detail cards for delivery, API totals, item snapshots and history. No transition/edit/cancel/collection/manual/bulk control is present; those are steps 84–89.

Not covered: browser interaction and visual inspection of the Orders workspace; query-plan measurements with representative production volume; live migration or staging. The production build validates compilation and route composition but not those browser behaviours.

## Step 84 — status transition commands and timeline actions (2026-10-13, local)

`pnpm verify -- --integration`: exit 0. Unit 577, integration 497, gateway 29, age-preview 2008, gate 2175. Production builds, format, lint, typecheck, package boundaries, infrastructure/reference checks and generated API contracts all passed.

`POST /v1/admin/orders/:id/transitions` enforces current `orders.transition`, admin Origin, strict UUID/body fields and a fail-closed staff mutation limit. Tests cover anonymous and revoked access, malformed IDs, unknown fields and the exclusion of cancellation from this command. Stale versions return `VERSION_CONFLICT`; skipped states return `INVALID_TRANSITION`; neither changes the order.

The complete Pending → Confirmed → Processing → Out for Delivery → Delivered path records versions 2–5, the acting staff member and database times. Five concurrent copies of one command create one transition and replay one receipt; reusing that command for another target or order returns `COMMAND_REUSED`. The resulting order has one creation plus four transition history rows, four audits and four `order.status_changed` events. Dispatch and delivery times are present, while COD remains pending. A forced audit failure proves the order update, history and event roll back together.

The admin detail exposes only the next valid fulfilment action to staff with `orders.transition`. It sends the displayed order version, retains its UUID across an uncertain retry and reloads the authoritative detail/timeline after success. Browser interaction and visual inspection, representative contention/load, live migration and staging remain outside this local step.

## Step 85 — versioned order edits and diff display (2026-10-13, local)

The verification-equivalent checks pass: unit 577, integration 499, gateway 29, age-preview 2008 and gate 2175. Format, lint, typecheck, package boundaries, infrastructure/reference checks and generated OpenAPI pass. All non-Next production builds pass through the installed Turborepo; admin and storefront production builds pass with Next's webpack builder. The normal `pnpm verify -- --integration` reached `build` and stopped because this execution sandbox forbids Turbopack's CSS helper from binding its internal local port (`EPERM`); the same source compiled with `next build --webpack`, and all remaining verify checks were then run individually.

**API/PostgreSQL (`admin-orders.int.test.ts`, 10 tests total):** the two Step 85 cases create saleable two-variant fixtures and exercise `PATCH /v1/admin/orders/:id` through the real Nest app. Three concurrent copies of one command produce one edit and replay the same receipt. A Pending edit increases one line, adds another, applies a coupon, corrects the address and sets an operational note in one commit. The test checks the recalculated AED total, one-unit net stock consumption per variant, one immutable edit row and a display-safe diff. A second edit removes a line and the coupon; stock is released once, the redemption becomes inactive, the remaining line and note appear in detail, and two edit diffs are returned.

A Confirmed order moves to Processing. A stale note is `VERSION_CONFLICT`, a merchandise edit is `ORDER_NOT_EDITABLE`, and a note-only edit succeeds at the next version. Removing the current actor's `orders.edit` grant immediately makes the endpoint 403. The pre-existing access, transition, rollback and snapshot cases also pass. Database integration now confirms the runtime role may delete replaceable `order_items` while it still cannot delete orders or rewrite history, and the canonical variant lock result includes the low-stock threshold needed by every stock writer.

**Invariants:** the migration permits historical coupon redemptions with one active redemption per order, adds `ORDER_EDIT` ledger movements tied to the order, and creates append-only `order_edit_history` with a deferred committed-version check. The service uses the canonical order/customer/delivery/catalogue/coupon/variant lock sequence, applies only net stock deltas, calls the low-stock crossing helper, preserves unchanged line price/catalogue snapshots, refreshes changed/new lines from current locked catalogue data, and atomically writes totals, coupon/address state, the diff, metadata-only audit and `order.updated`. `NO_CHANGES` rolls the transaction back.

**Admin UI:** staff with `orders.edit` can change quantities (zero removes), add a variant, replace/remove a coupon, edit permitted address fields and set/clear the operational note while Pending/Confirmed. Processing shows only the note. It submits the displayed version, reloads after a committed response and renders each immutable edit diff. Customer address fields remain hidden without `customers.read`; variant and area identifiers are returned only with `orders.edit`.

Not covered: interactive browser/visual QA of the order edit form; a searchable catalogue picker (the current add control accepts a variant identifier); representative production-volume query plans/contention; live migration or staging.

## Step 86 — order cancellation and returns (2026-10-14, local)

`pnpm verify -- --integration`: exit 0, before and after the review fixes. Unit 577, integration 509, gateway 29, age-preview 2008, gate 2175.

**Integration (`apps/api/src/orders/order-cancellation.int.test.ts`, real API and PostgreSQL, 10 tests):**

- **Refusals:** without `orders.cancel_before_dispatch` 403; another Origin 403; blank, missing or over-long reason, a bad command ID or an unknown field 400; a return list on a Pending order 400; an unknown order 404; nothing changes.
- **Before handoff:** a Pending order with a coupon (added by an edit) is cancelled: 2 units back, coupon use released, `cancelled`, cash `not_collected`, reason on the order and its history row, one audit entry without the reason text, one `order.cancelled` event; coupon counts and the stock ledger reconcile. The same command replays the same receipt; the same ID with another reason or another actor is `COMMAND_REUSED`; a new command is `ORDER_NOT_CANCELLABLE`; one `ORDER_CANCEL` movement.
- **Concurrency:** six different commands race on one order: one 200, five 409, stock back once. The same command sent twice at once: two 200s, one of them a replay, stock back once.
- **After an edit:** an order edited from 2 to 3 units returns 3, and stock ends where it began.
- **States:** Staff cancels a Processing order; a Delivered order is refused for Staff and Owner with stock and cash untouched; a stale version is `VERSION_CONFLICT`.
- **Return after handoff:** Staff is refused (403); missing, partial, over-counted, extra and duplicated classifications are `RETURN_INCOMPLETE`; the Owner's return of 2 resellable + 1 damaged puts 2 back, records the split, sets `returned_at`, shows it in the admin detail and replays. An all-damaged return puts nothing back but records the damage; upper- and lower-case IDs are the same command.
- **Rollback and immutability:** a failing audit write leaves the order, stock and records unchanged, and the same command then succeeds; the cancellation record, the reason and the order's ledger rows cannot be changed or added to by hand.

**Also:** `docs/api.openapi.json` regenerated (admin detail `returnItems`).

Not covered: the admin cancel panel in a browser; a low-stock re-arm event after a restock from a cancellation (the publisher is called; its own rules are tested in step 53).

## Step 87 — COD collection and Owner correction (2026-10-14, local)

`pnpm verify -- --integration`: exit 0, before and after the review fixes. Unit 582, integration 515, gateway 29, age-preview 2008, gate 2175.

**Integration (`apps/api/src/orders/order-collection.int.test.ts`, real API and PostgreSQL, 6 tests):**

- **No automatic collection:** a Delivered order's cash stays pending until recorded. Recording AED 65.00 with a reference sets the order's cash fields once (version 5), writes one record, one audit entry and one `order.collection_recorded` event; the same command replays; the same ID with another amount is `COMMAND_REUSED`; a second record is `COLLECTION_NOT_ALLOWED`.
- **Refusals:** Pending, Out for Delivery and Cancelled orders cannot be collected; a stale version, a future time and a time before delivery, a negative or fractional amount, an empty reference, an unknown field, another Origin and a missing `orders.collect` right are refused with nothing written; a collected order cannot be cancelled.
- **Concurrency and time:** a time in the minute of delivery is accepted and stored exactly; two different collections sent at once give one 200 and one 409 and one record.
- **Correction:** Staff is refused; an order without cash is `NOT_COLLECTED`; a blank reason is refused; a correction equal to the record in effect is `NO_CHANGES`; the Owner's correction from AED 60.00 to 65.00 is recorded with its reason while the order keeps the original amount, time, reference and actor; it replays; the admin detail lists both records; the audit entry holds the reason and both amounts.
- **Later corrections:** changing only the reference keeps the exact original time; a reused ID is refused; a second correction becomes the record in effect; two `order.collection_corrected` events.
- **Evidence:** record rows cannot be changed or deleted, and the order's cash fields cannot be rewritten or reset to pending.

**Unit (`apps/admin/lib/orders.test.ts`, 3 tests):** typed AED amounts become exact integer fils; malformed amounts are refused; date-time input round trip.

Not covered: the admin collection panel in a browser; reports reading the latest record (step 106).

## Age-gate Origin amendment (commit a307657, recorded 2026-10-14)

Unit tests in `apps/storefront/lib/age/age-gate.test.ts`: our Origin is accepted with `Sec-Fetch-Site` `same-origin`, `same-site` or `cross-site`; `Origin: null` is accepted only with `Sec-Fetch-Site: same-origin` and a forwarded host equal to a configured origin's host, and refused with a foreign forwarded host or `cross-site`; a missing, foreign or look-alike Origin is refused and no cookie is set. Included in every `pnpm verify` since (unit 582 on 2026-10-14). The gateway removes client-sent `X-Forwarded-Host`; ADR 0025 has the amendment and the reasoning.

Not covered: a real privacy-mode browser sending `Origin: null` end to end.

## Step 88 — manual orders (2026-10-14, local)

`pnpm verify -- --integration`: exit 0 after the review fixes. Unit 582, integration 522, gateway 29, age-preview 2008, gate 2175. Two earlier runs failed in unrelated suites (`settings.int.test.ts` connection timeout, `brands.int.test.ts` concurrency assertion) under load; `test:int` now runs two packages at a time and passed.

**Integration (`apps/api/src/orders/manual-orders.int.test.ts`, real API and PostgreSQL, 7 tests):**

- Staff see the active areas, fee and ETA, and get the same total as the storefront (2 × AED 40.00 + 15.00).
- A Pending manual order: `source='manual'`, `created_by` and a first history row by that staff member, stock taken, `order.created`; the same key replays; a changed request with that key is `IDEMPOTENCY_CONFLICT`; the same key from the Owner is the Owner's own attempt; the stock ledger reconciles.
- Confirmed start: without evidence, with evidence on Pending, or with an unknown channel 400; without `orders.transition` 403 and nothing written; with evidence the order is Confirmed and its first history row says "Confirmed by phone call: …"; it then moves to Processing normally.
- Refusals: without `orders.create` (create and quote) 403; missing or malformed key, no 18+ attestation, a client total, another Origin 400/403; nothing written.
- A total that moved is `QUOTE_CHANGED`, more than stock `INSUFFICIENT_STOCK`, a closed area `AREA_UNAVAILABLE`; stock unchanged.
- The same attempt sent twice at once makes one order; changed evidence or start on that key is a conflict; the staff member is on the order, its history and its audit entry.
- A coupon applies through the same rules (AED 60.00); the database refuses a Confirmed first history row without a reason.

Not covered: the admin New order form in a browser.

## Step 89 — bulk confirm (2026-10-15, local)

`pnpm verify -- --integration`: exit 0 before and after the review fixes. Unit 582, integration 526, gateway 29, age-preview 2008, gate 2175.

**Integration (`apps/api/src/orders/bulk-confirm.int.test.ts`, real API and PostgreSQL, 4 tests):**

- A mixed batch of three Pending orders, a stale version, a Delivered order and an unknown ID: three confirmed (one history row each), `VERSION_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, in the order sent; `no-store`. The same batch again replays all three with the same versions and no new history rows; a new batch with new command IDs for the same orders is `VERSION_CONFLICT` for each.
- The same batch sent twice at once: both answers say confirmed, each order has one confirmation. Another staff member reusing a command ID is `COMMAND_REUSED`.
- Bounds: 51 orders, an empty list, a repeated order, a repeated command ID and an unknown field are 400; another Origin 403; without `orders.transition` 403; nothing changes.
- Capitals are the same command (replay); a command ID reused in a later batch for another order is `COMMAND_REUSED`; two batches naming the same three orders in opposite orders at once confirm each order exactly once with no deadlock.

Not covered: an unexpected server error part-way through a batch followed by a retry (the replay path is shown above); the admin selection in a browser.

## Step 90 — admin customers and order WhatsApp messages (2026-10-15, local)

`pnpm verify -- --integration`: exit 0 before and after the review fixes. Unit 585, integration 529, gateway 29, age-preview 2008, gate 2175.

**Integration (`apps/api/src/customers/admin-customers.int.test.ts`, real API and PostgreSQL, 3 tests):**

- **List:** a phone with a delivered (AED 55.00), an open (AED 95.00) and a cancelled order is one customer with 3 orders and the latest area; Staff get no spend; the Owner gets booked AED 150.00 and delivered AED 55.00. Phone search by "050 650 0002" finds that customer; two digits match no phone; a customer without orders is not listed; `%` is searched literally; keyset pages are newest first; a bad cursor and an over-limit page size are 400.
- **Detail:** 2 orders newest first, no cancelled, the saved villa address, `private, no-store`; spend only for the Owner (booked AED 110.00, delivered 0); without `orders.read` the history is empty; without `customers.read` the list and detail are 403; an unknown customer 404.
- **WhatsApp:** the customer's number and two placeholder messages ("We received your order IH-… for AED 55.00 … reply YES", "is now: received"), with `wa.me` links carrying the encoded text; after the Owner sets a template, that wording is used with the store name, order number, total and support number, the other stays placeholder; reading the links writes no audit entry and no event; without `customers.read` 403.

**Unit (`packages/domain/src/whatsapp-templates.test.ts`, 3 tests):** placeholders filled and unknown ones left; values kept on one line; links only for an E.164 phone, text URL-encoded.

Not covered: the Customers screen and the WhatsApp panel in a browser; real wording (BI-09).

## Step 91 — inbox, read receipts and event stream (2026-10-15, local)

`pnpm verify -- --integration`: exit 0 before and after the review fixes. Unit 585, integration 534, gateway 29, age-preview 2008, gate 2175.

**Integration (`apps/api/src/notifications/inbox.int.test.ts`, real API and PostgreSQL, 5 tests, stream timings shortened):**

- **Own read flags:** the staff inbox lists its two notifications newest first, unread 2, `private, no-store`; reading one keeps the first time on a second read; the Owner's receipt of the same notification stays unread (Owner unread 3); someone else's or an unknown notification is 404; paging and the unread filter; read-all up to the newest seen marks the rest; a malformed `upTo` is 400.
- **Current permission:** without `orders.read` the `order.new` notifications disappear from the list and cannot be marked, while a low-stock one stays; without `notifications.read_own` the inbox and the stream are 403.
- **Stream:** `text/event-stream`, `no-store`, `X-Accel-Buffering: no`, `event: ready`; a notification written after connecting arrives as `id: <notification id>` with only its ID and type, never its content; heartbeats; two notifications written while disconnected arrive after reconnecting with `Last-Event-ID`; a fourth stream beyond the per-user bound is 429.
- **Ending:** revoking the session sends `event: signed-out` and ends the stream; removing `notifications.read_own` ends it with `event: reconnect`; its slot is free again.

Not covered: the bell in a real browser through the gateway (`scripts/check-gateway.mjs` already checks that the stream route is not buffered); shutdown ending open streams; the per-process bound.

## Step 92 — low-stock alerts, daily-summary slot and operations acceptance (2026-10-15, local)

`pnpm verify`: exit 0 (unit 587, age-preview 2008; the contract was regenerated for the new setting). `pnpm test:int`: exit 0 (integration 540; platform 1, db 14, worker 13, api 36 files). `pnpm test:gate`: exit 0, 2175 checks. `invariant-reviewer`: no blockers. Its one low finding, an email lost when a send keeps failing past the window, is now an accepted loss stated in ADR 0060.

**Low stock (`apps/worker/src/low-stock-notifications.int.test.ts`, real PostgreSQL, 5 tests):**

- Three sales take a variant through its alert level and then on to zero. That writes one `inventory.low` event with both consumers. The event produces one notification, with the stock at delivery time ("Out of stock (alert level 10)") and a link to `/inventory/<id>`. Receipts go only to users who hold `inventory.read`. One email goes out, with no link. A redelivery returns `duplicate`.
- A variant that drops low, recovers and drops low again inside 24 hours alerts once in the inbox and once by email. Once the window has passed, the next crossing alerts again.
- Two crossings handled at the same time write one notification.
- A variant restocked before delivery, a draft product, and alerts that are switched off: none of them sends anything or claims the window.
- A missing variant ends as `dead`.

**M8 operations journey (`apps/worker/src/operations-gate.int.test.ts`):**

1. `createStoreOrder` sells 3 of 5 units, with the alert level at 2.
2. Staff get one inbox entry each for the new order and the low stock, and both emails go out. Neither the inbox nor the emails contain the customer's name, address or phone.
3. Staff move the order Pending → Confirmed → Processing → Out for Delivery → Delivered, each step with its expected version.
4. At Delivered, `codStatus` is still pending. Staff then record the cash, which sets `codStatus` to collected; sending the same command again returns the original record.
5. A further sale while the variant is low writes no second event.

**Daily summary:** `daily-summary.test.ts` checks that the slot is 09:00 Asia/Dubai (05:00Z), that `catchUp` is 1, and that a run sends nothing.

**Order edit, cancel, collection and session suites:** all passed in the same `test:int` run.

Not covered:

- The M8 journey runs at service level. The HTTP routes and guards for transitions and collection have their own API tests.
- The bell and the settings switch have not been checked in a real browser.
- Real email still waits for BI-07.
- The daily summary has no figures until step 106.

## Step 93 — review schema and verified-purchase proof (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 587, integration 546, gate 2175. `invariant-reviewer` found no blockers. It raised two low findings, both fixed:

- Submission now locks the order before the proof.
- The message text now uses replacer functions.

**Integration (`apps/api/src/orders/review-link.int.test.ts`, real API and PostgreSQL, 6 tests):**

- **Refusals:** a pending order gives 409 `REVIEW_NOT_ALLOWED`; an unknown order gives 404; a foreign origin gives 403; a missing `customers.read` gives 403. None of these writes a proof.
- **Issuance:** the answer is 201 with `no-store`. The link is `https://<domain>/review#<43 characters>`, with a `wa.me` message that contains the link. The database holds the token's SHA-256 with a 30-day expiry. The token appears nowhere in `review_proofs` or `audit_log`, and the issue writes one audit row. `readReviewProof` returns only the product ID and name.
- **Abuse:** these all give `REVIEW_PROOF_INVALID`:
  - an order ID used as a token;
  - a well-formed guess;
  - the replaced (older) link;
  - another order's product;
  - an expired proof.

  The live link works once per product, then the issue route answers `NOTHING_TO_REVIEW`.

- **Concurrency:** two submissions sent at once with one link record exactly one review.
- **Database:** these are refused:
  - a product the order does not contain;
  - a review that starts approved;
  - a content edit;
  - a delete;
  - an expiry change.

  Moderation (status, moderator, time, version) is allowed.

- **Settings:** without the store domain, the route answers `STORE_DOMAIN_REQUIRED`.

Not covered:

- The admin panel has not been tried in a real browser.
- The `/review` page and the submission route come in step 94.
- The link wording is placeholder until BI-09.

## Step 94 — store review submission and pending moderation (2026-10-15, local)

`pnpm verify -- --integration`: exit 0, run again after the review fixes: unit 592, integration 556, gate 2175. `invariant-reviewer` found no High or Medium findings. It raised four low ones:

- **Fixed:** ZWNJ and ZWJ are now allowed in names. Only control characters and invisible or direction-changing marks are refused.
- **Fixed:** a unique violation now maps to `REVIEW_PROOF_INVALID`.
- **Confirmed, no change:** the gateway overwrites `X-IH-Client-IP` (`header_up`).
- **Accepted:** the 10-per-minute submission limit could catch customers behind a shared mobile NAT.

**Integration (`apps/api/src/store/store-reviews.int.test.ts`, real API and PostgreSQL, 8 tests):**

- **Refused with 403:** no ticket, a forged ticket, a crawler user agent, a foreign Origin, `Sec-Fetch-Site: cross-site`. A form post gets 415. None of them writes anything.
- **Proof read:** only `expiresAt` and `[{ productId, name }]`, with `private, no-store` and `no-referrer`. No order ID, order number, customer name, phone or amount.
- **One code (409 `REVIEW_PROOF_INVALID`) for:** a well-formed guess, a token one character off, a replaced link, another order's product. An order ID sent as the token is refused as 400.
- **Contract refuses:** rating 0, 6, 4.5 or "5"; an empty or too-long title; a title with NUL or U+200B; a body that is too short, too long or holds a bell character; an empty or too-long name; the fields `status`, `verified` and `orderId`; broken JSON.
- **Submission:** 201 `{ pending, remaining: 0 }`. The stored text is normalised and the review is pending with no moderator. The audit row has actor system and none of the words. One `review.submitted` event carries the `notification` effect. A second submission for the same product, and the proof read afterwards, both answer `REVIEW_PROOF_INVALID`.
- **Concurrency:** of six parallel submissions for one purchase, one returns 201 and five return 409. One row is stored.
- **Limit:** the 11th submission from one address in a minute gets 429, refused ones included. Another address still works.
- **Notification:** the title names the product and the body gives the stars, never the author or the text. Writing it again creates nothing new. Receipts go to Owners only.

**Worker (`apps/worker/src/review-notifications.int.test.ts`, 2 tests):** the real `EffectRunner` completes the effect once, and a rerun writes no second notification. Staff (no `reviews.moderate`) get no receipt. With the inbox switched off, the effect completes and writes nothing.

**Unit:** `apps/storefront/lib/reviews.test.ts` covers fragment parsing, the recheck link (token only in the fragment, return `/review`), how answers are read (a proof answer with extra fields is refused), and the form rules (ZWNJ kept, U+202E refused). The logger test checks that `token` and `authorName` are redacted.

**Browser (`scripts/browser-qa/review.mjs`, Chromium at 360px, real served stack after `checkout.mjs` with 49 passed): 15 passed.**

- The order went through the real commands to Delivered and got a link.
- The page HTML holds no product name. The token leaves the address bar and appears in no API URL, Referer or device storage. No order number or amount is shown, and there is no horizontal scroll.
- An empty send shows four messages and sends nothing. A review is stored as `pending|4|Smooth draw|Q. A.`.
- The served worker wrote "New review: Gatecheck Halo".
- A reload, and the used-up link, both say the link can't be used. Still exactly one review.

The fragment hand-over through the age question was checked separately in Chromium with a stand-in server (307 to the question, form post, 303 back). The URL came back as `/review#<token>`, and the server saw only `return=/review`.

Not covered:

- A real phone, and WhatsApp's in-app browser opening the link.
- The served gate's own redirect, which goes to the https origin that this local pass cannot open.
- Moderation and public display (step 95).
- Placeholder wording until BI-09.

## Step 95 — review moderation and the public rating (2026-10-15, local)

`pnpm verify -- --integration`: exit 0 after the review fix: unit 592, integration 561, age preview 2013, gate 2175. `invariant-reviewer` found no blocking findings and raised four low ones:

- **Fixed:** the admin list now reads items, counts and the average in one repeatable-read snapshot.
- **Checked, no change:** nothing reads the event's `aggregateVersion`.
- **Accepted:** the list read has no rate limit (it is permission-gated), and the public list uses index keys (static per render).

**Integration (`apps/api/src/reviews/admin-reviews.int.test.ts`, real API and PostgreSQL, 5 tests):**

- **Access:** Staff get 403 on both routes, no session gets 401, and a foreign origin gets 403. These are refused with 400 and change nothing: a bad status, rating, product ID, cursor or limit; an unknown decision; a missing or zero version; an extra field; an ID that is not a UUID. An unknown review gives 404.
- **Public:** a pending review is not on the product page, whose rating is null and list empty. Approving it at version 1 returns version 2. The page, which was cached, then shows `{ average: 4, count: 1, distribution: [0,1,0,0,0] }` and the review, marked verified, with no order ID, order number or review ID.
- **Conflicts:** a stale version gets `VERSION_CONFLICT`, and a repeated decision gets `INVALID_TRANSITION`.
- **Hiding:** rejecting the approved review takes it off the page again. The stored content is unchanged and the moderator is recorded.
- **Records:** the audit entries are `review.submitted`, `review.approved` and `review.rejected`, and two `catalog.changed` events are written for the product.
- **Averages:** with reviews of 5 and 2 approved and one of 1 rejected, each product page counts only its own approved reviews, and the admin average is 3.5 over 2.
- **List:** counts and keyset pages (limit 1 plus the cursor) are correct, as are the rating and product filters. The order is shown for the Owner.
- **Concurrency:** two simultaneous decisions on the same version give one 200 and one 409, and the review ends at version 2.

**Age preview (stub API):** the verified product page shows the rating line "4.5 · 2 reviews", the review title, body, author with date ("14 Oct 2026") and "Verified purchase". Unverified requests never reach the API.

**Browser (`scripts/browser-qa/admin-reviews.mjs`, Chromium through the gateway, real API on a test schema): 14 passed.**

- Two pending reviews are listed newest first, with the verified label and "Pending 2".
- Approving one removes it from Pending, and the summary changes to "5.0 average from 1 published review".
- Rejecting the other leaves "No reviews waiting".
- Approved shows "Hide (reject)", Rejected holds the rejected one, and an empty filter says "No reviews here".
- The database matches the decisions.
- No horizontal scroll at 390px and no page errors.
- Staff see no Reviews link and get "Access unavailable".

Not covered:

- The storefront product page with real reviews in a browser. Its markup is checked through the stub age preview.
- Two API replicas: cross-replica invalidation relies on the existing `catalog.changed` → `storefront_revalidate` path (step 52 evidence).
- Placeholder wording until BI-09.

## Step 96 — content-section schemas and draft/published storage (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 597, integration 566, age preview 2013, gate 2175.

The first run failed in `apps/worker/src/checkout-gate.int.test.ts`. The test checked the whole Mailpit JSON for the phone fragment "630", and a random hex message ID contained it. The test now checks only what a reader sees (subject, text, HTML and recipients), and the rerun passed.

`invariant-reviewer` found no blockers.

- **Medium, recorded in ADR 0064:** publishing reads the catalogue without locks, so the step 98 read side's re-check is the guarantee.
- **Low, fixed:** product media routes now see only product assets, the worker writes content derivatives under `content/<id>/`, the image guard also covers `purpose` and `product_id`, and more invisible characters are refused.
- **Low, accepted:** references in a disabled banner are checked anyway.

**Unit (`packages/contracts/src/content.test.ts`, 5 tests):**

- There are seven keys with current schemas, and an unknown version throws.
- Text is trimmed to plain text. These are refused: `<b>`, a bell character, U+202E, a soft hyphen, a tag character, too long, blank, fewer than 2 or more than 6 messages.
- These links are refused: a URL, a slug, an href on `shop`. An image needs alt text and an asset ID (no data URL). An empty title and extra fields are refused.
- Lists refuse repeats and more than 8 items. Automatic best sellers refuse a list. There are at most 2 banners, and offers refuse coupon codes.
- References are found once each, across buttons, images and lists.

**Integration (`packages/db/src/content.int.test.ts`, real PostgreSQL, 5 tests):**

- **Access:** Staff are refused on save, list and publish.
- **Drafts:** a new draft starts at version 1, unpublished, with normalised text. Invalid content is refused. A stale version and a second "new" save are `VERSION_CONFLICT`.
- **Publishing:** publishing copies the draft (version 2). Publishing again gives `NOTHING_TO_PUBLISH`, and a new draft leaves the published copy alone. One `content.published` event carries the section ID. The audit entries are draft saved, published, draft saved.
- **References:** a draft product and a missing product block publishing, reported as `not_visible` and `missing`. A product image used as a hero image is `missing` (only content images count). A ready content image publishes, and then cannot be removed or turned into a product image.
- **Database:** these are refused:
  - a published copy that is not the draft;
  - an update that does not advance the version;
  - a key change;
  - a delete;
  - an insert that starts published;
  - an unknown key;
  - a content asset with a product;
  - a product asset without one.
- **Concurrency:** of two simultaneous first saves, one wins and the other gets `VERSION_CONFLICT`.

Not covered:

- No routes or editor (step 97) and no public read (step 98).
- Content image upload is not wired: the worker key path is in place, but no route creates content assets yet.

## Step 97 — content APIs and editor (2026-10-15, local)

`pnpm verify -- --integration`: exit 0, run again after the review fixes. Unit 597, integration 571, age preview 2013, gate 2175.

`invariant-reviewer` found no blockers.

- **Fixed:** save and publish answer with the committed record, not a second read. A chosen image older than the newest 60 keeps a clear label. A test now shows a product image is unknown to the content completion route.
- **Already recorded (ADR 0064):** publishing does not lock the catalogue; the read side re-checks.
- **Accepted:** an invalid stored draft returns a bare 409, and the preview and image reads are not rate limited (Owner only).

**Integration (`apps/api/src/content/admin-content.int.test.ts`, real API, PostgreSQL and MinIO, 4 tests):**

- **Access:** Staff get 403 on all six route kinds, no session gets 401, and a foreign origin gets 403.
- **Refused with 400, nothing stored:** an unknown key, a `<script>` title, an extra field, a URL link, a negative version, a body field outside the contract. An empty title gives `fields: [{ path: "content.title" }]`.
- **Save and publish:** the list shows all seven sections at version 0. A save gives version 1 with `no-store`. A second "new" save is `VERSION_CONFLICT`. Publishing gives version 2 with the published copy equal to the draft, and publishing again gives `NOTHING_TO_PUBLISH`. Publishing a section never saved gives 404. The `content.published` effect is `storefront_revalidate`.
- **Preview:** it lists the visible product first and the draft product as not visible, with the price from. Publishing then gives 409 `CONTENT_REFERENCES` with `fields: [{ path: "product:<id>", message: "not_visible" }]`. An unsaved section's preview gives 404.
- **Content images:**
  - Upload authorization returns no product. The real POST goes to MinIO.
  - The product completion route gives 404; the content route completes (`purpose=content`, `uploaded`, no product, one `media.uploaded`), and the image is listed without a URL until ready.
  - A hero using it cannot publish (`image:<id>`, `not_ready`).
  - A product image is unknown to the content completion route.
  - The 11th open upload is refused with 409.

**Worker (`apps/worker/src/revalidate.int.test.ts`):** `content.published` snapshots `storefront_revalidate` and completes after one signed catalogue invalidation.

**Browser (`scripts/browser-qa/content-editor.mjs`, Chromium through the gateway, qa-server API and worker): 18 passed.**

- **States:** a new section reads "Not set up".
- **Promotional bar:** markup is refused by the form. A save leaves it "Draft, never published", the preview shows the saved messages, and Publish makes it "Live".
- **Featured products:** a product hidden after being picked blocks publishing, named "“Draft QA …” is not visible". After removing it, the section publishes.
- **Hero:** the uploaded image was processed by the worker and offered. The preview showed the processed image, and the hero published with typed data (link kind `shop`, asset ID).
- **Editing:** "Unsaved" shows, and Discard restores the saved draft.
- **Records:** three publishes wrote three `content.published` events.
- **Layout and access:** no horizontal scroll at 390px and no page errors. Staff see no link and get "Access unavailable".

Not covered:

- The public read and the home page (steps 98–99).
- Pruning content images: none is ever removed yet.
- Placeholder wording until BI-09.

## Step 98 — published home content read (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 597, integration 575, age preview 2013, gate 2242. After the review fix, `pnpm test:gate` was run again and passed 2242 checks.

`invariant-reviewer` found no blockers.

- **Fixed:** the gate check now parses the JSON instead of matching key order.
- **Confirmed:** the cache invalidation clears everything (`invalidateAll`).
- **Accepted:** sold-out cards stay in manual lists, and image links are cached for up to 60 s (they live for 10 minutes).

**Integration (`apps/api/src/store/store-content.int.test.ts`, real API, PostgreSQL and MinIO, 4 tests):**

- **Age ticket:** no ticket, a forged ticket and a crawler user agent all get 403.
- **Drafts:** before anything is published, every section is null or empty. A saved draft is not shown. Once published it is shown, and a newer draft does not replace it.
- **Assembly:**
  - The hero button resolves to `/brands/<slug>`. The featured order is kept, there are two brands, and only the enabled banner is shown, its button resolving to `/p/<slug>`. Offers are shown.
  - No IDs or stock values appear in the answer.
- **Re-checking references:**
  - After the kit is unpublished, it leaves featured, and the banner keeps its title but loses its button.
  - After the brand is hidden, the hero button and the featured cards go.
- **Automatic best sellers:** they include the recent sellers that are in stock and leave out the sold-out one (at most 8).

**Gate (`scripts/check-gate-e2e.cjs`):** the route is refused without a ticket through the gateway. With a ticket, it answers the empty home.

Not covered:

- The home page itself (step 99).
- Content images in the public answer: they are covered by the same signing code as product images, but not tested here.

## Step 99 — home hero, ticker and curated sections (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 597, integration 575, age preview 2030, gate 2242.

The first run failed in `apps/api/src/auth/age.int.test.ts`. The test searched the whole refusal body for the price "4900", and a random request ID contained it. It now leaves out the request ID before checking, and the rerun passed.

`invariant-reviewer` found no blocking, high or medium findings.

- **Fixed:** the banner text uses a token colour, the hero image is fetched with high priority, and the age-preview checks clean up in `finally`.
- **Kept on purpose:** the promotional bar on every shop page, recorded in the ADR 0066 addendum.

**Age preview (stub API):** with no content (the stub answers 404), the home page shows the catalogue fallbacks. With published content it shows the ticker, hero title, eyebrow and subtitle, "Popular right now", the best seller, the banner, the offers title and product, and "Pause offers ticker". The hero button links to `/brands/orbe`. The looping copy carries `aria-hidden`, and the bar also shows on `/shop`.

**Browser (`scripts/browser-qa/home.mjs`, real served stack, Chromium; content published with the real storage commands): all passed at 360px, at 1280px, and at 360px with reduced motion.**

- The hero, promotional bar, banner and offers are shown.
- The ticker animates only without reduced motion, and the pause button pauses it.
- No horizontal scroll and no page errors.

Fixed after looking at the screenshots:

- On phones the hero circle sat behind the headline (low contrast); it now sits in the bottom corner.
- The three-way toggle wrapped onto two rows; it is now equal columns.
- A banner without an image showed an empty saffron block; it now has no art column.

Not covered:

- A content image on the home page in a browser: the hero and banners were published without images.
- Real phones.
- BI-09 wording.

## Step 100 — offers, help and free-delivery rule (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 599, integration 575, age preview 2189, gate 2434. The reference check now includes the demo-copy guard.

`invariant-reviewer` found no blockers.

- **Fixed:** a zero fee reads "Included in your total".
- **Recorded:** once free delivery is enabled, the API should send the remaining amount with the quote.
- **Accepted:** the guard regex is a tripwire, not proof.

**Unit:** `lib/cart/free-delivery.test.ts` checks that nothing shows for a null or zero threshold, and that with a threshold it gives the remaining amount and percentage, or "reached".

**Guard:** `scripts/check-reference-set.mjs` was run with a temporary probe file containing HAVEN10. It failed, naming the file. With the probe removed, it passed.

**Age preview (stub API):**

- `/offers` and `/help` are restricted without a ticket.
- Offers lists only the reduced product, and the API was asked for `sale=1`.
- Help shows "AED 15 per order", the delivery time, "Dubai, Sharjah" (from the areas) and cash on delivery.
- Home, Offers and Help carry no "free delivery" text and no demo code.

**Gate:** both pages are refused through the gateway without a ticket.

**Browser:** both pages, on the real served stack at 360px, answered 200 with no horizontal scroll and no page errors. The FAQ got a visible +/− mark afterwards.

Not covered:

- A free-delivery threshold in a browser: it cannot be enabled by contract.
- BI-01/BI-09 wording.

## Step 101 — slug changes, former slugs and canonical URLs (2026-10-15, local)

`pnpm verify -- --integration`: exit 0. Unit 599, integration 576, age preview 2194, gate 2434.

The first run failed in a storefront unit test: its brands fixture lacked `formerSlugs`. That was fixed.

`invariant-reviewer` found no blockers. Accepted and recorded in ADR 0068: the 20-former-slug limit, and the different error order (409 before 403) for brands and categories.

**Integration:**

- **Products (`apps/api/src/catalogue/products.int.test.ts`):**
  - A Staff slug change is refused with 403, while a Staff edit without one succeeds and writes no redirect.
  - The Owner renames twice, and both old slugs point straight at the product.
  - Taking back the first slug removes its own alias.
  - Another product cannot take a former slug or the current one (`DUPLICATE`).
- **Brands and categories:** a Staff slug change is refused with 403. The existing rename, reclaim and alias tests still pass.
- **Database (`packages/db/src/catalogue.int.test.ts`):** `listStoreBrands` returns former slugs newest first. A hidden brand is not listed, so its former slugs lead nowhere.

**Age preview (stub API):** `/brands/orbe-old` redirects to `/brands/orbe`, and `/categories/disposables-old` redirects to `/categories/disposables`. The brand page declares `<link rel="canonical" href="…/brands/orbe">`.

Not covered:

- The admin's read-only slug field in a browser.
- Listing filters with former slugs (ADR 0068).

## Step 102 — review and content acceptance pass, M9 gate evidence (2026-10-16, local)

`pnpm verify -- --integration`: exit 0. Unit 599, integration 580, age preview 2194, gate 2434. The new suite passed three runs in a row.

This step adds one suite, `apps/api/src/content/content-acceptance.int.test.ts` (4 tests). It runs the real API, PostgreSQL and the cache with a 1-second TTL:

- **Two editors:** two simultaneous saves on the same version give one 200 and one 409 `VERSION_CONFLICT`. The stale editor also cannot publish until it reloads. Each change is audited once.
- **Refused publish:** a publish refused for a draft product leaves the live home content exactly as it was.
- **Propagation:** a publish through the admin route is visible at once on that replica. A publish written without the route (as another replica would) is visible within the TTL. Every publish writes its `storefront_revalidate` effect.
- **Cache and gate:** a cache warmed by a verified shopper still answers 403 with no content to no ticket or a forged ticket.

**Done condition, item by item:**

| Item                        | Evidence                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid references rejected | Step 96: `packages/db/src/content.int.test.ts` (draft or missing product, product image used as content). Step 97: `admin-content.int.test.ts` (409 `CONTENT_REFERENCES` with `<kind>:<id>`, image `not_ready`). Step 98: `store-content.int.test.ts` (references re-checked at read time). Browser `content-editor.mjs` (hidden product named). |
| Multiple-editor conflict    | This step (saves and publish), and step 96 (two first saves, DB).                                                                                                                                                                                                                                                                                |
| Publish retry and TTL       | Step 97: `apps/worker/src/revalidate.int.test.ts` (`content.published` invalidation, retry on an unavailable API, dead after rejected keys). This step: propagation within the TTL without an event.                                                                                                                                             |
| Order-proof abuse           | Steps 93–94: `review-link.int.test.ts` and `store-reviews.int.test.ts`: an order ID as token, a guessed token, a replaced or expired link, another order's product, parallel submissions (one wins), rate limit, no order data in answers. Browser `review.mjs`.                                                                                 |
| Cache and gate behaviour    | Step 98: route refused without a ticket, also through the gateway (`check-gate-e2e.cjs`). This step: a warmed cache never answers an unverified request. Age preview: home, offers, help and redirects restricted.                                                                                                                               |

**M9 gate:** "Storefront and admin prototype content and review interactions work with real data." The evidence is above plus the browser passes: review link (step 94), admin Reviews (step 95), content editor (step 97), and home at 360px, 1280px and reduced motion (step 99). **Not marked passed: Marina decides.**

Not covered:

- Two real API replicas: the cross-replica path is the worker effect, which has its own tests.
- Real phones and WhatsApp's in-app browser.
- BI-09 and BI-13 wording and scope.

## Step 103 — anonymous browsing events (2026-10-16, local)

`pnpm verify -- --integration`: exit 0 after the review fixes. Unit 601, integration 586, age preview 2194, gate 2434.

The first run failed in `admin-customers.int.test.ts`: its `beforeAll` timed out after 10 s under parallel load, before any of its tests ran. This is the known parallel-load flake, not caused by this change, and the rerun passed.

`invariant-reviewer` found no high-severity issues.

- **Medium, fixed:**
  - Arabic-Indic digits now count as digits (NFKC).
  - Search terms over 40 characters or 4 words are stored as `null`.
  - Search rows carry no anonymous ID.
- **Low, fixed:**
  - A slug lookup prefers the current slug over a former one.
  - At most 2 batches are written at once, with a 2-second statement timeout.
  - The runtime role cannot update or truncate `events`.
  - The cleanup job warns when it leaves a backlog.
- **Recorded in ADR 0069:** a chunked body is bounded by the global 32 KB limit; the address header comes from the gateway (existing pattern).

**Unit (`packages/contracts/src/telemetry.test.ts`):**

- Terms are normalized.
- These are stored as `null`: a phone number with spaces, a "+971" number, Arabic-Indic digits, an email, a long name-and-address phrase, a term over 40 characters, a zero-width mark.
- Batches outside the contract are refused: empty, more than 20 events, an unknown type, an extra field, a bad quantity, slug or ID, an extra top-level field.

**Integration (`apps/api/src/store/store-events.int.test.ts`, real API and PostgreSQL, 6 tests):**

- **Refused:** no ticket and a foreign origin get 403, and a non-JSON body gets 415. Nothing is stored.
- **Stored:** all six types (7 events), with products resolved to IDs. The term "grape ice" is normalized, and a "+971 50 …" term is stored as `null`. The anonymous ID is kept on non-search rows only. No phone digits, IP or cookie appear in the stored rows.
- **Duplicates and drops:** a resent event counts as `duplicate`. A draft product, a variant of one, and an unknown slug are `dropped`. A former slug counts for its product.
- **Contract limits:** 21 events, an empty batch, extra fields and an unknown type get 400. A body over 8 KB gets 413.
- **Rate limit:** the 61st batch from one address in a minute gets 429.
- **Retention:** an event 91 days old is deleted, and a second pass deletes nothing.

Not covered:

- The storefront sending events (step 104).
- Daily rollups (step 106).
- Load behaviour beyond the in-process cap.

## Step 104 — storefront telemetry batching and overload (2026-10-16, local)

`pnpm verify -- --integration`: exit 0 after the review fixes. Unit 610, integration 586, age preview 2194, gate 2434.

During the fixes, a run failed once. The events test searched the stored rows, random UUIDs included, for "971", and a UUID contained it. It now checks types and payloads only; three reruns passed, then the full verify.

`invariant-reviewer` found no blocking or high-severity issues.

- **Fixed:**
  - Events waiting when a quiet page is reached are dropped (no idle timer loop).
  - A search term that may be personal is normalized in the browser and sent as `null`; the contract allows `null`.
- **Recorded in ADR 0070:** a page leave sends one batch at most, and wishlist events carry the rotating anonymous ID.

**Unit (`apps/storefront/lib/telemetry/telemetry.test.ts`, 9 tests):**

- **Batching:** batches of 20 then 5, unique IDs, and the last batch sent with keepalive.
- **Full queue:** new events are dropped.
- **Failures:** one retry with the same IDs, then dropped. A thrown send counts as a failure; a refusal is final.
- **Overload:** a 429 or 503 drops what waits and pauses for one minute.
- **Quiet pages:** checkout, confirmation and review pages record nothing and drop what waits. `/checkouts` is not quiet.
- **Sampling:** works per type.
- **Status mapping:** the answer codes map to the outcomes in ADR 0070.
- **Anonymous ID:** kept for 24 hours, then replaced; unreadable storage gives a new one.

**Integration:** `store-events.int.test.ts` also stores a search whose term the storefront already sent as `null`.

**Browser (`scripts/browser-qa/telemetry.mjs`, real served stack, Chromium at 360px): 12 passed.**

- A search, a product view, a save and an add to cart reached the database, with the term stored normalized.
- Event bodies held no personal fields, and device storage held only the cart, the lists and `ih_anon_v1`.
- The checkout page sent no telemetry.
- With the events route answering 503:
  - add to cart was immediate (under 2 s);
  - checkout opened;
  - the route was tried at most twice;
  - no page errors.

CI on the PR then failed in `pricing-acceptance.int.test.ts`. Its "no tax/vat/excise" check searched the whole quote, and the random quote token contained such letters. It now checks only the fields and text, with tokens and UUIDs left out. The same random-value risk was also removed from `admin-reviews.int.test.ts`, which now uses the displayed order number, not bare digits.

Not covered:

- Real phones and slow networks.
- Rollups (step 106).

## Step 105 — financial metric definitions and summary query (2026-10-16, local)

`pnpm verify -- --integration`: exit 0. Unit 614, integration 590, age preview 2194, gate 2434.

The first full run failed in the new suite, though it had passed on its own. The test sent the collection correction time from the test machine's clock, and the database (Docker) refused it as before delivery or in the future. The test now uses the database's own delivery time and passed three runs in a row.

`invariant-reviewer` found no blocking issues.

- **Fixed:** the permission check moved inside the snapshot, and the range bounds are cast to `timestamptz`.
- **Added:** a Dubai-midnight boundary test.
- **Recorded:** the collected cash amount versus the order total (ADR 0071).

**Unit (`packages/domain/src/metrics.test.ts`):**

- **Day bounds:** one Dubai day is 20:00 UTC to 20:00 UTC, and a leap year has 366 days.
- **Refused ranges:** an impossible date, a reversed range, a non-padded date, and a range over a year.
- **AOV:** half-up to the fil (8166.67 → 8167, 500.5 → 501), none for no orders, and out of range refused.
- **Rates:** basis points rounded half-up.

**Integration (`packages/db/src/financial-metrics.int.test.ts`, real PostgreSQL, 4 tests).** The four orders were made with the real commands:

- **A:** pending.
- **B:** delivered.
- **C:** delivered, collected at 6500, then corrected to 6000.
- **D:** cancelled.

Results:

- **Booked:** 3 active orders, merchandise net 20,000, delivery 4,500, total 24,500, AOV 8,167. Cancelled: 1 order, total 16,500.
- **Delivered:** 2 orders, total 18,000, AOV 9,000.
- **Collected:** 1 order, 6,000. The correction replaced the first record; it was not added to it.
- **Cancellation rate:** 2,500 bps.
- **Status mix:** correct, and every basis is labelled by its Dubai date basis, with the tax note.
- **Other days:** a range of earlier days counts nothing, and has no average or rate.
- **Dubai midnight:** an order at 19:59:59.999Z counts on the earlier Dubai day, one at 20:00:00Z on the next.
- **Access and ranges:** Staff are refused, and so are impossible ranges.

Not covered:

- A route or UI: the dashboards are step 109, the reports step 111.
- Daily tables for long ranges (step 106).

## Step 106 — daily aggregate tables and idempotent rollups (2026-10-16, local)

`pnpm verify -- --integration`: exit 0. Unit 614, integration 595, age preview 2194, gate 2434.

Expected changes to older tests (a new required consumer):

- The event catalogue test, the order and checkout tests and the M7 and M8 gate tests now expect `analytics_rollup` on order events.
- Two tests that needed an event with no consumers now use `delivery.configuration_updated`.

`invariant-reviewer` found no blocking issues.

- **Fixed:**
  - A day past the raw-event retention keeps its search and saved-list rows.
  - Indexes on `orders(delivered_at)` and `order_collection_records(collected_at)`.
  - A comment on the lock order.
- **Tried and reverted:** a repeatable-read rollup made parallel recomputes conflict (the snapshot is taken before the lock wait). The rollup stays in Read Committed, as recorded in ADR 0072.
- **Recorded:** no backfill until step 107.

**Integration (`packages/db/src/daily-rollups.int.test.ts`, real PostgreSQL, 4 tests).** The four step 105 orders, plus browsing events:

- **Sales:** the `sales_daily` row equals `readFinancialSummary` for that day, with placed 4, cancelled 1 and collected 6000 after the correction.
- **Products:** 4 ordered units (the cancelled order left out) and 3 delivered.
- **Search:** "grape" has 2 searches with 1 zero-result; the `''` bucket has 1.
- **Saved list:** 2 adds and 1 remove.
- **Idempotent:** running the day again, and three times at once, gives identical rows.
- **Brand:** after the catalogue brand is renamed, the row keeps the order item's snapshot name.
- **Days:** `orderRollupDays` lists the days an order touches. An impossible day is refused. An empty day gives an all-zero sales row, and a day past retention keeps its search row.

**Worker (`apps/worker/src/analytics-rollup.int.test.ts`):** three real `order.status_changed` events, run by the `EffectRunner`, filled today's row (delivered 6500). A redelivery is a `duplicate`, and the figures stay the same.

Not covered:

- The scheduled recent-day pass, the backfill and today's freshness (step 107).
- Load on very busy days.

## Step 107 — recent-day rollups, backfill, freshness and daily summary (2026-10-16, local)

`pnpm verify`: exit 0 (unit 620, age preview 2194; contracts regenerated for the new setting and event). `pnpm test:int`: 599 of 600 passed. The one failure was `admin-orders.int.test.ts` (search by order number returned a second seeded order). It passed twice on rerun, and this step does not touch it. `invariant-reviewer` found nothing material.

**Integration (`apps/worker/src/daily-summary.int.test.ts`, real PostgreSQL, 5 tests):**

- **One slot, one event:** two schedulers ticking the same moment complete the summary slot once. Three more concurrent runs of that slot add no event. A direct second insert is refused by `outbox_events_one_daily_summary`.
- **Permissioned recipients:** the Settings list holds an Owner, a staff user without `dashboard.financial_read`, a deactivated Owner and an address with no account. Only the active Owner is in Bcc. The text shows booked AED 180.00 for 2 orders, labels each basis with its date meaning, and has no links, customer name or phone.
- **Off or nobody permitted:** no setting, or a list with no permitted staff, sends nothing.
- **Freshness:** with no rows, both days are reported missing. The today job fills yesterday and today; a second run gives the same figures with a newer `computedAt`. The nightly job fills the 7 days before today.
- **Backfill:** 11 named days are recomputed oldest first, and a second run gives the same figures. A range ending after today, or longer than 366 days, is refused.

**Unit:** daily summary slot (09:00 Dubai, `catchUp: 1`); the template escapes product names; the backfill CLI refuses a missing, impossible, reversed, over-long or future range, unknown parts and extra flags, and never prints error details; the domain day helpers handle the Dubai midnight boundary, month and year ends, and invalid input; the admin setting needs a recipient.

Not covered:

- A real email send (BI-07).
- Load on very busy days.
- The dashboard display of `computedAt` (step 109).

## Step 108 — operational home dashboard (2026-10-16, local)

`pnpm verify`: exit 0 (unit 620, age preview 2194). `pnpm test:int`: exit 0 (605 tests). `invariant-reviewer` found nothing material. Its optional suggestion was applied: deleted products are left out of top products.

**API (`apps/api/src/dashboard/admin-dashboard.int.test.ts`, real API + PostgreSQL, 5 tests).** Three open orders were seeded, one of them pending for 3 hours.

- No session: 401.
- **Staff:**
  - Open counts are 2 pending and 1 confirmed; delayed is 1, and the 3-hour order leads the attention list.
  - Recent orders carry the customer's name (Staff has `customers.read`). No phone or address appears anywhere in the answer.
  - The out-of-stock variant is listed.
  - Reviews and sales are `null`.
  - Top products show 4 units with no amounts.
- **Rights withdrawn:** without `customers.read` the names are `null`; without `orders.read` and `inventory.read`, the orders, top-product and stock sections are `null`. Restoring the rights brings them back.
- **Owner:**
  - Before a rollup, today and yesterday are `null` ("not computed").
  - After `rollupDay`: 3 orders, AED 245.00, AOV 8167 fils (half-up), with a `computedAt` and the tax note.
  - Reviews count present; top products carry amounts.
- **Deactivated staff:** refused.

Not covered: a real-browser pass of the home page; the delay limits await BI-14.

## Step 109 — Owner analytics (2026-10-16, local)

`pnpm verify`: exit 0 (unit 624, age preview 2194). It first stopped at lint: the screen set state synchronously inside an effect. The loading state moved to the range handlers. `pnpm test:int`: exit 0 (608). `invariant-reviewer` found nothing material.

**API (`apps/api/src/dashboard/admin-analytics.int.test.ts`, real API + PostgreSQL, 3 tests):**

- **Refusals:** no session 401; Staff 403; an impossible date, a range over a year, a missing `to` or an unknown field 400.
- **Before any rollup:** the 3 days are listed as missing, with no per-day rows and zero totals. The live status mix already shows the 2 orders.
- **After `rollupDay`:**
  - The booked totals equal `readFinancialSummary` for the day: 2 orders, AED 180.00, AOV 9000 fils, cancellation 0.
  - The previous period (the day before) is reported as 1 missing day with no AOV.
  - The product with 2 units leads; its share is undefined because nothing has been delivered.
  - Brand units total 3.
  - Search: 4 searches, 2 with no results (50.00%), 1 term not kept; "mango ice" is the no-result term; the `''` bucket is never listed.
  - Saved lists: 2 adds and 1 remove, with the product out of stock.

**Unit (`apps/admin/lib/analytics.test.ts`):** ranges are Dubai days, today included; basis points show as one decimal, rounded half-up; the comparison never divides by zero; day lists cross month ends correctly.

**Browser (`scripts/browser-qa/dashboard.mjs`, headless Chromium through the gateway, 18 checks, all PASS):**

- **Owner, home:** counts, booked sales with "As of", and recent orders.
- **Owner, Analytics:**
  - The booked-order count equals `sales_daily`, and the tax basis is shown.
  - The chart has one slot per day of the range, with gray marks for days not computed; focusing a column reads out its AED value.
  - The Search tab lists the no-result term, and every tab opens.
  - The 7-day range names the missing days.
- **Layout:** no sideways scrolling at 390px on either page.
- **Staff:** no sales figures and no Analytics link; Analytics shows "Access unavailable".
- **Both roles:** no page errors.

The screenshots were reviewed by eye. The first version stretched a single computed day across the whole chart, and was fixed to give one slot per day of the range.

Not covered:

- Dark-theme screenshots.
- Real touch input.
- Ranges with heavy data.

## Step 110 — report jobs: request and status (2026-10-16, local)

`pnpm verify`: exit 0 (unit 624, age preview 2194). `pnpm test:int`: exit 0 (613). After the final trigger change, api lint, typecheck and format check were run again and passed. `invariant-reviewer` found nothing material; both of its notes were applied.

**API (`apps/api/src/reports/admin-reports.int.test.ts`, real API + PostgreSQL, 5 tests):**

- **Refusals:** no session 401; Staff 403 on request and list. Each of these is a 400, and none of them creates a job: an unknown type, an unknown basis, an impossible date, a range over a year, a range ending after today, a range on inventory, an extra field, a missing command ID.
- **Stream and replay:**
  - A 7-day sales report becomes a `stream` job: `ready`, available, estimate 7, expiring 15 minutes after creation, `private, no-store`.
  - The same command again returns 200 with the same job. The command reused for another report gets 409 `IDEMPOTENCY_CONFLICT`, and still only one row exists.
  - There is one `report.requested` audit entry by the Owner, and no event for a stream.
- **Estimates and permissions:**
  - The orders estimate counts order lines (2).
  - A role with `reports.export` but no `customers.export` gets 403 for customers and 201 for sales.
  - The Owner's customers job stores both required rights.
- **File jobs and immutability:**
  - With the stream limit lowered, inventory becomes a `file` job, `queued`, not available, with exactly one `report.requested` event.
  - Changing the type or the requester is refused.
  - Once completed, its file key cannot change and it cannot go back to queued.
- **Own jobs only:**
  - Each requester lists only their own jobs, newest first.
  - Another person's job ID, or an unknown one, answers 404; a malformed ID answers 400.
  - Without `reports.read`, both the list and the status answer 403.

Not covered here: generating and downloading (steps 111–112). The UI arrives in step 112.

## Step 111 — CSV generators and the streamed download (2026-10-16, local)

`pnpm verify`: exit 0 (unit 628, age preview 2194). `pnpm test:int`: exit 0 (618).

`invariant-reviewer` found one real bug: the keyset cursors on orders and customers carried a millisecond JS `Date`, so rows would repeat at every batch boundary of a large report. The fix uses microsecond text cursors. A new test pages the orders, inventory and customers reports with a batch size of 1 and compares them with one batch:

- Fixed code: the test passes.
- Cursor temporarily put back to `new Date(...)`: the test fails ("never repeats or skips a row across batch boundaries").
- The fix was restored afterwards.

**Unit (`packages/domain/src/csv.test.ts`):**

- `=`, `+`, `-`, `@`, tab and CR at the start of text get `'`, phone numbers included. Text with `=` in the middle is left alone.
- RFC 4180 quoting works for commas, quotes, line breaks and edge spaces.
- Amounts come from integer fils, including negatives. Basis points become percentages. A non-integer number or exponent text is refused.
- Times are Dubai time.

**API (`apps/api/src/reports/report-downloads.int.test.ts`, real API + PostgreSQL, 5 tests).** The test reads the CSV with its own RFC 4180 parser and checks the raw bytes for the UTF-8 byte-order mark.

- **Sales:**
  - Booked: one row per day; the 2 days not computed say "not computed" and have empty figures. Today shows 2 placed, 2 booked, AED 150.00 net, 30.00 delivery, 180.00 total, 90.00 AOV and 0.00% cancelled.
  - Delivered: today shows 1 order, 100.00, 15.00, 115.00.
  - Collected: 0 orders.
  - The file name names the basis and the range.
- **Orders:**
  - One row per line, with status now, totals 65.00 and 115.00, and no address.
  - A customer name `=HYPERLINK(...)` comes out as `'=HYPERLINK(...)`, and phones as `'+971…`.
- **Products, inventory and customers:**
  - Products: delivered 2 units, 1 order, 100.00 net.
  - Inventory: 2 variants, out of stock, with the snapshot time; the file name is `…-as-of-<day>`.
  - Customers: 2 customers, the injected name defused, delivered spend 115.00 and 0.00.
  - The download is audited with `personalData`.
- **Refusals:**
  - Another person's job or an unknown ID: 404. No session: 401.
  - An expired stream: 409 `REPORT_NOT_AVAILABLE`. So does a file job, until step 112.
  - A requester who lost `customers.export` after requesting customers data: 403, and no audit entry is written.
- **Batch boundaries:** see above.
- **`admin-reports.int.test.ts`:** the orders report now also needs `customers.export`.

Not covered: built files, signed links and expiry cleanup (step 112); opening the files in a real spreadsheet program.

## Step 112 — report files, signed downloads, expiry and the Reports screen (2026-10-16, local)

`pnpm verify`: exit 0 (unit 629, age preview 2194). `pnpm test:int`: exit 0 (624).

`invariant-reviewer` found two real issues, both fixed and tested:

- The signed `Location` would have been written to the API access log. The response log now keeps only the status code, and the logger redacts `Location`; a unit test checks that a signed link never reaches the output.
- A file could outlive a failed job. The worker tests now cover a file from an earlier attempt, a stale job's file, and a job failed during its upload (a storage wrapper fails the job mid-upload); none leaves an object behind.

**Worker (`apps/worker/src/reports.int.test.ts`, real PostgreSQL and MinIO, 4 tests):**

- **Build once:** an inventory file job is built once: completed, 2 rows, attempts 1, kept 7 days. The object starts with the UTF-8 byte-order mark, has 3 lines and matches the recorded size. A redelivery is a duplicate.
- **Lost right:** a requester who lost `customers.export` gets `failed`/`REQUESTER_FORBIDDEN`, and no object remains, including one stored earlier.
- **Upkeep:**
  - An expired stream becomes `expired`.
  - A dead build becomes `failed`/`BUILD_NOT_FINISHED`, and its object is removed.
  - A completed file past 7 days is deleted from storage and the job marked `expired`; the record and its key stay.
  - A second run changes nothing.
- **Race:** a job failed during its upload ends with no object.

**API (`apps/api/src/reports/report-files.int.test.ts`, real API, PostgreSQL and MinIO, 2 tests):**

- **Download:**
  - The requester gets 303 with `no-store` and `no-referrer`.
  - The `Location` is a link into the reports bucket with `X-Amz-Expires=300` and an attachment file name.
  - The link downloads the CSV on its own; the same object without a signature is 403.
  - One audit entry is written.
- **Refusals:** another person's job is 404. Lost rights are 403 with no `Location`. Expired and still-queued jobs are 409. None of them writes an audit entry.

**Browser (`scripts/browser-qa/reports.mjs`, headless Chromium through the gateway, 14 checks, all PASS):**

- **Sales:** ready at once, and downloads with a named file and the byte-order mark.
- **Customers:** asks first; dismissing sends nothing, and accepting downloads the file.
- **File job:** queued in the database, built by the qa-server worker; the screen notices it by itself, and it downloads through its signed link.
- **Audit:** the downloads are audited.
- **Layout:** fits 390px without sideways scrolling.
- **Staff:** no Reports link, "Access unavailable", and 403 for the Owner's file by its ID.
- **Both roles:** no page errors.

The first run caught a 390px overflow: a visually hidden table header was positioned outside the scroll box. The fix (`.order-table-wrap` `position: relative`; `.dashboard` columns `minmax(0, 1fr)`) applies to every admin table. `dashboard.mjs` was re-run afterwards: 18/18.

Not covered:

- Dark-theme screenshots.
- Real touch input.
- A production storage provider (BI-06).
- Reports large enough to approach the 200,000-row limit.

## Step 113 — SEO policy, issue report, public sitemap and the SEO screen (2026-10-16, local)

`pnpm verify`: exit 0 (unit 634, age preview 2243). After the case fix, `pnpm test:age-preview` passed 2245, and storefront lint, typecheck and unit tests passed. `pnpm test:int`: exit 0 (627).

`invariant-reviewer` found nothing material; it compiled the header pattern and tried the near-miss paths. One low note was fixed: a `/Terms`-style spelling now gets `noindex` from the proxy.

**Storefront (`pnpm test:age-preview`, built storefront over HTTP with a stub API whose policy changes mid-run):**

- **Closed, and with the policy API down:**
  - robots disallows everything, allows nothing and names no sitemap.
  - `/sitemap.xml` is public and lists nothing.
  - The three policy pages have `noindex` in both the header and the meta tag.
- **Public pages:**
  - robots still disallows everything else, allows exactly the three pages and names the sitemap.
  - The sitemap lists exactly those three, on our origin.
  - Those pages have `index` meta and no `noindex` header.
  - `/Terms` and `/PRIVACY` keep `noindex`.
  - A catalogue page keeps `noindex`.
  - No sitemap ever lists a catalogue address.

**Unit:** the policy is closed on a failed fetch, a 500, an unknown value or an extra field; it is held for the configured time; only the three policy paths are ever indexable. The gate lets `/sitemap.xml` through but not `/sitemap.xml/x` or `/sitemap-products.xml`.

**API (`apps/api/src/seo/admin-seo.int.test.ts`, real API + PostgreSQL, 3 tests):**

- **Default:** the public answer is `closed` with `public, max-age=60`. The overview lists the features: generic previews, canonical addresses and redirects active; sitemap and the three product features inactive.
- **Changing the policy:**
  - Staff 403 and no session 401. An unknown value, an extra field or a missing version gets 400.
  - The Owner opens it: version 1, the sitemap active, product indexing still inactive, and the public answer follows.
  - A stale version gets 409 `VERSION_CONFLICT`; the same value again changes nothing.
  - One audit entry and one event are written.
  - The Settings screen does not list `seo`.
- **Issue report:** Staff 403. It checks 3 published products, 1 brand and 1 category (a draft is skipped), and finds one title over 60 characters, a duplicate title across a product and a brand, and a category without SEO fields.

**Browser (`scripts/browser-qa/seo.mjs`, 13 checks, all PASS):**

- **Defaults:** closed by default; product indexing listed as inactive and not a switch; the issue report shows the seeded brand.
- **Changing the policy:** dismissing changes nothing; accepting opens the public pages, shows the sitemap as active and is audited; closing again works.
- **Layout:** fits 390px.
- **Staff:** no link and no access.
- **Errors:** no page errors.

The first screenshots showed each radio button alone on its own line, then a 390px overflow. The fix was a dedicated choice style, a fieldset `min-width`, and an auto-width radio. `dashboard.mjs` and `reports.mjs` were re-run afterwards: all passed.

Not covered:

- A real crawler or search console.
- Product indexing (BI-05; not built).

## Step 114 — dashboard, report and SEO acceptance pass; M10 gate evidence (2026-10-16, local)

`pnpm verify -- --integration`: exit 0.

- unit 634;
- age preview 2245;
- integration 630 (platform 6, db 139, worker 85, api 400);
- gateway 29;
- real-stack gate 2434.

It first stopped at lint: a literal byte-order mark in the new test, now written as an escape.

**New in this step: `apps/api/src/dashboard/m10-acceptance.int.test.ts`** (real API and PostgreSQL, 3 tests). Two orders were seeded around a Dubai midnight:

- one placed at 23:30 on day A, delivered at 00:30 on day B, with cash collected at 10:00 on day C;
- one placed at 23:59 on day A, then cancelled.

The test checks three things:

- **One day per basis, everywhere.**
  - The live summary puts booked AED 115.00 on A with a cancellation rate of 50.00%, delivered 115.00 (net 100.00) on B, and collected 115.00 on C. No basis leaks onto another day.
  - Analytics over A..C equals the live summary over A..C, with no day missing. Its per-day placements and deliveries are on A and B.
  - The sales CSV shows the figure on the same day for each basis: booked on A, delivered on B, collected on C.
- **Recomputing never changes a figure.** The three days are backfilled again, then backfilled twice more at the same time as single-day recomputes. The four daily tables, compared without `computed_at`, are identical row for row. The test also checks that the rows exist (three sales days and products), so it is not a comparison of empty tables.
- **Fields per role on every M10 route.**

  | Route                   | Owner | Staff                       | Finance only (`dashboard.financial_read`) | Clerk (`reports.read` + `reports.export`) |
  | ----------------------- | ----- | --------------------------- | ----------------------------------------- | ----------------------------------------- |
  | Analytics               | 200   | 403                         | 200                                       | 403                                       |
  | Reports list            | 200   | 403                         | 403                                       | 200                                       |
  | Report request          | 201   | 403                         | 403                                       | 201                                       |
  | SEO overview            | 200   | 403                         | 403                                       | 403                                       |
  | SEO issues              | 200   | 403                         | 403                                       | 403                                       |
  | Home dashboard sections | all   | orders, stock, top products | sales only                                | —                                         |

  The Staff dashboard carries no product amounts, phone or address. The clerk is refused the customers report (403), and gets 404 for the Owner's job and its download.

### M10 gate evidence

Gate: _Operational dashboards/reports contain correct real data, access is permissioned and SEO UI reflects actual indexing policy._

| Item                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Financial and date definitions correct | Step 105: `financial-metrics.int.test.ts` (bases, AOV half-up, Dubai days, corrections). Step 106: daily rows equal the live summary. **This step:** across a Dubai midnight, the summary, daily rows, analytics and CSV agree per basis.                                                                                                                                                  |
| Idempotent backfill and rollups        | Step 106: a repeated or parallel recompute gives the same rows; the analytics consumer redelivered. Step 107: the scheduled today and recent-day jobs; the backfill CLI. **This step:** concurrent backfills and recomputes leave all four tables unchanged.                                                                                                                               |
| Field denial                           | Step 108: dashboard sections by right, rights withdrawn mid-session. Steps 109–113: each route's allowed and refused roles. **This step:** the role-by-route matrix above. Browser: `dashboard.mjs`, `reports.mjs`, `seo.mjs` (Staff sees no sales and no Analytics, Reports or SEO).                                                                                                      |
| Export security                        | Step 110: requester-only jobs, command replay and conflict. Step 111: formula defusing, personal-data reports need `customers.export`, audited downloads, the batch-boundary test. Step 112: signed 5-minute links after the checks, no link or audit on refusal, no orphan files, links kept out of logs. **This step:** the clerk cannot reach customer data or another person's report. |
| Correct real data on screens           | Browser passes `dashboard.mjs` (18), `reports.mjs` (14) and `seo.mjs` (13) on seeded orders and events through the gateway, at 1366px and 390px. No sample values: missing days are named, never zero.                                                                                                                                                                                     |
| SEO UI reflects the indexing policy    | Step 113: `admin-seo.int.test.ts` (features follow the policy; product indexing always inactive). `pnpm test:age-preview` checks the storefront under closed, API-down and public-pages policies. Browser `seo.mjs` (policy switch, active/inactive labels).                                                                                                                               |
| Preview and age-boundary tests         | `pnpm test:age-preview` 2245 (generic previews, no product data for any agent, robots, sitemap, policy pages). `pnpm test:gate` 2434 (real API, storefront and gateway).                                                                                                                                                                                                                   |

Not covered, and decided by Marina or by business input:

- **BI-05:** product indexing, previews and JSON-LD are not built.
- **BI-07:** real email for the daily summary waits for a verified sending domain.
- **BI-14:** the delay limits are the prototype's values.
- **Not exercised here:** a production storage provider (BI-06), real crawlers and preview platforms (staging), dark-theme screenshots, real touch input, very large data volumes.

Do not mark M10 passed without Marina's decision.

## Step 115 — full prototype parity review (2026-10-16, local)

Review: `docs/parity-review.md`. It covers the 19 areas and the shared states, with 26 gaps registered, each with evidence, a tier and a size.

- **Method:** two read-only code inventories (storefront and admin) against the prototype symbols in `docs/prototype-map.md`. The main claims were then checked by hand:
  - `ProductGridSkeleton` is unused.
  - There are no mobile sheets (ADR 0033 "Not built here").
  - The Notifications section had no screen.
  - The orders list reads no URL filters.
  - Manual order lines take a typed variant ID.
  - The requirements said "Dubai only".
- **Fixed in this step:**
  - The admin Notifications inbox page. The browser pass `dashboard.mjs` (now 20 checks, all PASS) checks that it is not the placeholder and that it fits 390px.
  - The requirements wording.

`pnpm verify`: exit 0 (unit 634, age preview 2245).

Not covered: the prototype's own behaviour was not run; the comparison is symbol by symbol. Real devices are step 120.

## Step 116 — commerce concurrency regression (2026-10-16, local)

`pnpm verify`: exit 0 (unit 634, age preview 2245). `pnpm test:int`: exit 0 (637). The new suite was also run 5 times in a row: 7/7 every time.

**`apps/api/src/orders/concurrency-regression.int.test.ts`** (real PostgreSQL, pool of 20). Each test races different commands at the same moment. A refusal must be one of the known business errors (version or stock conflict, insufficient stock, coupon refused, idempotency conflict or in progress, quote not accepted, transaction contention); any other error fails the test.

| Race                                                                                          | Holds                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6 checkouts of 1 unit, a damage write-off and a count at "3", against 3 units                 | At least one sale goes through, and sales plus damage never exceed 3. The final stock is exactly 3 − sold − damaged: the count applies only while nothing has left. Ledger equals balance.     |
| Cancel, two edits (lines, coupon) and a transition at one order version, 4 rounds             | Exactly one wins each round, and the version moves once. When the cancel wins, both lines return in full. Ledger and coupon counters reconcile.                                                |
| 4 cancels (2 sharing a command ID)                                                            | One cancellation record, one `ORDER_CANCEL` movement; the stock is back to 5.                                                                                                                  |
| 4 checkouts with a single-use coupon, plus an edit adding it to another order                 | Exactly one live redemption, and the counters match.                                                                                                                                           |
| 4 cash records (2 sharing a command ID, different amounts), then 2 corrections at one version | One record, then exactly one correction.                                                                                                                                                       |
| One checkout key: 3 identical requests and 1 with changed lines                               | One order and one sale; the stock falls by 1.                                                                                                                                                  |
| Whole database afterwards                                                                     | No ledger mismatch and no negative stock; coupon counters equal live redemptions; every cancelled order has one cancellation and one return per line; no live redemption on a cancelled order. |

Not covered: load at volume (step 121); worker and queue failure (step 117).

## Step 117 — worker crash and Redis-loss recovery drill (2026-10-16, local)

`pnpm verify`: exit 0 (unit 634, age preview 2245). `pnpm test:int`: exit 0 (642). The drill was run 3 times in a row: 5/5 each time.

**`apps/worker/src/recovery-drill.int.test.ts`** (real PostgreSQL and queue Redis; the real relay, reconciler, runners and the inbox, email and analytics consumers; a stub email provider that accepts once per delivery key, as Resend does with `Idempotency-Key`):

| Injected failure                                                              | What holds                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The relay claims the event and dies before enqueue; its lease expires         | The event stays undispatched; a healthy relay takes it over and queues all three effects.                                                                                         |
| Redis loses every queued job, then late copies of the original job IDs arrive | The reconciler re-enqueues all 3 from PostgreSQL. Each effect completes with 1 attempt; one notification, one email; the day's placed count matches; nothing stranded.            |
| Crash after the provider accepted, before completion was recorded             | The effect retries. Both attempts carry the same delivery key, so the provider delivers once.                                                                                     |
| Lease lost mid-send, then the new owner dies too                              | The stale worker gets `lease_lost` and cannot finish; after the lease expires a new worker reclaims it and the email is delivered once.                                           |
| Permanent provider refusal                                                    | The effect goes dead with `RECIPIENT_REJECTED`, and the event is not complete. The Owner's replay is audited (`effect.replayed`); the email is sent once and the event completes. |
| 3 copies of every effect on 3 workers, then once more                         | Exactly 3 completions, the rest duplicates. The provider is asked once; nothing changes later; ledger and stranded checks are clean.                                              |

**Step 116 fix:** under full-suite load the idempotency race was won by the 2-unit payload, while the test expected the 1-unit one. The test now asserts one order and one sale, stock reduced by the winner's quantity, and conflicts or in-progress answers for the rest. The product behaviour was already right.

Not covered: a real Redis failover and a production restore (steps 122–126, provider-dependent).

## Step 118 — auth, privacy, gate, token and key regression (2026-10-17, local)

`pnpm verify -- --integration`: exit 0 (unit 636, age preview 2245, integration 645, gateway 29, gate 2586). After the reviewer's fix, `pnpm test:gate` was run again: 2586.

**Coverage.** A read-only inventory mapped each condition and scenario to existing tests:

- **Owner guard** (including simultaneous attempts): `staff-administration` and `staff-role`.
- **Reset and invite reuse, concurrency, expiry and revocation:** `password-reset` and `staff-invitation`.
- **Logout, deactivation, role change, idle and absolute expiry:** `auth`, `access` and `staff-*`.
- **Cookie attributes:** `auth`, `session-cookie` and `age-gate`.
- **Key rotation and revocation; wrong, expired or tampered tickets:** `age-ticket.test.ts` and `age.int.test.ts`.
- **No product data, warm cache, previews:** `check-age-preview` and `check-gate-e2e`.
- **No checkout data on the device:** browser `checkout.mjs`.
- **RBAC-01/02:** `access` and `m10-acceptance`; report downloads.

**Gaps closed in this step:**

| Gap                                        | New evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSE on a real deactivation and role change | `inbox.int.test.ts`: the real `deactivateStaff` / `changeStaffRole` end an open stream with `signed-out`, and the cookie then opens no new one (401). **Product fix:** the stream used to end with `reconnect` (its inbox poll failed first), so the browser was not told to sign out. On a failed poll the stream now checks the session and says `signed-out` when it is invalid. The rest of the suite is unchanged (losing the inbox right still gives `reconnect`); 3 runs, 7/7 each. |
| Age ticket on admin routes                 | `age.int.test.ts`: a valid ticket alone on `/v1/auth/me`, dashboard, orders, customers, reports and the event stream → 401, with no cookie set.                                                                                                                                                                                                                                                                                                                                            |
| Legacy `co`/`lastOrder`                    | `lib/device/legacy.test.ts`: both storages lose exactly those keys (with planted name and phone) and keep the cart and lists; a blocked storage or a refusing one does not stop the rest.                                                                                                                                                                                                                                                                                                  |
| Logger                                     | `index.test.ts`: `authorization` and a response `set-cookie` never reach the output.                                                                                                                                                                                                                                                                                                                                                                                                       |
| AUTH-01 through the real gateway           | `check-gate-e2e.cjs` §7, on the admin surface published on loopback: <ul><li>the sign-in sets `__Host-ih_admin` with `Path=/; Secure; HttpOnly; SameSite=Strict` and no `Domain`;</li><li>the session works for `/auth/me`;</li><li>the storefront origin has no sign-in (404);</li><li>the admin session opens nothing on the storefront;</li><li>an age ticket is 401 on the admin origin;</li><li>a sign-in from the storefront origin is refused (403).</li></ul>                      |
| PRIV-01 exports                            | `report-downloads.int.test.ts`: the exact column lists of the orders and customers exports. Personal data is the name, phone and area only; no address, notes, Makani or staff email.                                                                                                                                                                                                                                                                                                      |

`invariant-reviewer`: one low finding, fixed. On failure, the gate check would have printed the session token; it now prints only the cookie's attributes.

Not covered:

- Traces (no tracing backend yet; step 125).
- A WhatsApp user agent in the preview list (platform tests are step 120).

## Step 119 — selected-profile cache, limiter and replica verification (2026-10-17, local)

Profile: budget (BI-06, one Hostinger VPS): one API process, an in-process catalogue cache, local limiters and no cache Redis. `pnpm verify`: exit 0 (unit 637, age preview 2245). `pnpm test:int`: exit 0 (649).

| Item                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL and invalidation               | Unit (`cache.test.ts`): TTL capped at 60 s; expiry frees bytes; a load that began before an invalidation is never stored or served. Integration (`revalidate.int.test.ts`): local invalidation after a committed admin change and on a signed worker call. **New** (`budget-profile.int.test.ts`, production profile settings, TTL 1 s): a change made behind the API is served from memory within the TTL and fresh after it with no signal; a restarted API starts cold and current. |
| Bounds                             | Unit: entry and byte bounds, an oversized value not cached, bounded concurrent and queued misses. Config: TTL ≤ 60, bounded entries, bytes and misses.                                                                                                                                                                                                                                                                                                                                 |
| Checkout limiter fallback          | Unit (`rate-limit.test.ts`): bounded local fallback for checkout with a per-process ceiling; authentication fails closed; key caps with a shared overflow ceiling. On budget the local limiter is the authority. **New:** with no Redis at all, one address gets exactly 240 catalogue reads a minute and then 429 with Retry-After, another address is unaffected, and the 11th sign-in per identity and network is refused.                                                          |
| Per-instance ceilings              | `limit-policies.ts` divides fallback budgets by `RATE_LIMIT_MAX_REPLICAS`. **New:** the budget profile refuses any value other than 1 (`index.test.ts`), so a second process cannot silently run with its own cache and limits; more replicas require the replicated profile with `CACHE_REDIS_URL` and `RATE_LIMIT_KEY_SECRET` (already enforced).                                                                                                                                    |
| Identical cache rules for replicas | Budget: there is one replica by configuration. The storefront keeps no second cache (ESLint rule: every server fetch uses `cache: "no-store"`). Cache keys carry `CATALOGUE_CACHE_VERSION`. Replicated (not selected): shared entries, cluster-wide invalidation and outage fallback are unit-tested.                                                                                                                                                                                  |

Not covered:

- The VPS itself: memory headroom, a container restart under load (steps 121–122).
- An edge or CDN layer.

## Parity G-A1 — order item picker and returning-customer lookup (2026-10-17, local)

ADR 0080. `pnpm verify`: exit 0. `pnpm test:int`: exit 0 (650, one new test).

| Item                         | Evidence                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Picker lists orderable items | Integration (`manual-orders.int.test.ts`): name, brand and SKU each find the variant; an inactive variant, a draft product and LIKE wildcards find nothing; option label in option order; override price; a never-stocked variant is listed as sold out.                                            |
| Access                       | Same test: `orders.edit` alone opens the picker, neither right gives 403, and no session gives 401. `@RequireAnyPermission` is covered by the startup route check (`@Serialize` required).                                                                                                          |
| Browser journey              | `scripts/browser-qa/order-picker.mjs`: all checks PASS. A new number creates the customer, a 0-prefixed retype finds the same customer, name and saved address are filled, a sold-out or already added variant cannot be added, the order edit adds a picked variant, 390px has no sideways scroll. |
| Found and fixed              | Every manual order submitted from the admin failed validation (a top-level `areaId` in the strict request). The browser pass caught it; API tests had not, because they send their own body.                                                                                                        |

Not covered:

- Real mobile touch and screen reader use of the picker list.
- More than 30 matches: staff narrow the search, and there is no paging.

## Parity G-A2 — admin deep links (2026-10-17, local)

ADR 0081.

| Item            | Evidence                                                                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API filters     | Integration: `admin-orders.int.test.ts` lists a pending order older than 2 h under `delayed=true` but not a 2.5 h confirmed one (3 h rule), combines it with `status`, and refuses `delayed=yes`; `inventory.int.test.ts` returns exactly the requested variant for `variantId`. |
| Link mapping    | Unit (`lib/links.test.ts`): a notification path becomes the exact order or stock link; anything but a UUID, a nested path or an outside URL gives no exact link.                                                                                                                 |
| Browser journey | `scripts/browser-qa/deep-links.mjs`: all 18 checks PASS: order URL, reload, Back; dashboard pending, delayed, recent order and low stock; bell; inbox; customer and their history; product URL; malformed ID. `order-picker.mjs` still all PASS.                                 |

Not covered:

- Review links in the browser: the markup is the same `Link` as elsewhere, and typecheck covers the IDs. The review fixtures live in `admin-reviews.mjs`.

## Parity G-S1 — storefront cart sheet (2026-10-17, local)

ADR 0082.

| Item                | Evidence                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sheet behaviour     | `scripts/browser-qa/cart-sheet.mjs` on the served gate stack: all 14 checks PASS at 360px (bottom sheet, focus, quantity, Escape, continue, cart page) and 1280px (quick add hand-over, side panel, remove last line, outside click), with no page errors. |
| Cart page unchanged | `checkout.mjs`: 49/49 PASS after the line list moved into `CartLines`. Two stale expectations were updated: the anonymous ID from step 104, and the `analytics_rollup` effect of step 107 (all 6 effects completed).                                       |
| No payable total    | The sheet shows the buyable-lines subtotal only and leads to the cart page, where the server quote is accepted (ADR 0041).                                                                                                                                 |

Not covered:

- Real phones (touch, on-screen keyboard, iOS dialog quirks): step 120.
