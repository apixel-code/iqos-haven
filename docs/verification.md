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

- **BI-02 gate:** a complete product still reports `tax_treatment`, and publish answers `PUBLISH_REQUIREMENTS`.
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
