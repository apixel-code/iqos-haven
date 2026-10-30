# Deploy, migrations and rollback

Status: staging/production procedure; provider/account/domains/IaC and actual deployment are pending BI-06. The container reference is a staging skeleton, not a release approval.

## Before first staging deployment

Select budget or replicated profile, UAE regions and provider eligibility; provision independent DB/queue/storage/secrets. Lock deployed image digests and service identities. Configure private API/DB/queue network, same-origin gateway/header policy, DNS/TLS/CSP and email destination allowlists. Fill only non-secret IDs/config into deployment review; use the secret manager for credentials.

## Release sequence

1. Verify reference/contract/boundary/format/lint/type/unit checks and PG18 integration. Business E2E/concurrency/failure/load gates must also pass for the modules being released.
2. Review migration SQL: constraints/grants/append-only history, clean install, previous-version compatibility, locks/index plan and expand/deploy/contract separation.
3. Build each image once, scan, record digests/release IDs. No .env/demo data/build-cache credentials in context. Never rebuild a different image between staging and production promotion.
4. Execute `pnpm db:migrate` with environment-specific migration identity. Missing/empty bundle is an error; --allow-empty is restricted to local development and never a release workaround.
5. Deploy compatible app/worker images, observe readiness/effects, run actual-origin smoke checks. Queue outage can degrade API without discarding accepted orders.
6. Client UAT/business-policy/sign-off, backup/restore evidence and operator readiness are required before production promotion.
7. Promote approved digests, run expand migrations and monitored rollout; defer contract/destructive changes until after rollback window.

## Rollback

Stop the affected rollout; identify last known-good digest and current schema compatibility. Roll back app/worker images only when compatible. Preserve order/idempotency/effect state; no automatic DB downgrade or volume deletion. Restore into an isolated environment if recovery is required and measure data reconciliation; never restore a snapshot blindly over current accepted orders. Record version/command/effect IDs rather than customer PII.

## On the VPS (staging and production, step 128)

1. CI's **Images** run builds every image once and lists its digests in `release.env`. Copy that file to `releases/<sha>.env` on the server.
2. **Rehearse first:** run `./rehearse.sh releases/<new>.env`. It does four things:
   - restores a fresh backup into an isolated copy;
   - applies the new migrations there;
   - starts the **current** API on the migrated copy, which proves rollback safety;
   - starts the new API there too.

   It never touches live data or the queue.

3. **Release:** run `./deploy.sh releases/<new>.env`. It refuses any image that is not pinned by digest, migrates, and starts the services in order. Then it smoke-checks them and records `release.current.env`.
4. **Roll back:** run `./deploy.sh releases/<previous>.env`. This is safe because every ordinary migration is expand-only.
   - `pnpm test:migrations` enforces that rule in CI.
   - A breaking change goes into a later `*_contract` migration marked `-- contract-after: <release>`. It ships only after the rollback window of the release that stopped using the old shape.
5. **Expect a few seconds of 502** while the storefront and admin restart: 3–4 s measured on staging. Release in a quiet hour.

## Rollback decisions (operator)

| Symptom after a release                         | Action                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App error, migration was additive (expand only) | Redeploy the previous image digests of API, worker, storefront and admin; the old code runs on the new schema                                                                                         |
| A migration failed half-way                     | Stop; do not rerun with changes. Prisma marks it failed: fix forward with a reviewed migration, never edit history                                                                                    |
| Data damaged by the release                     | Keep the store running if orders are safe; restore a backup into an isolated drill DB (`pnpm ops:restore-drill <set> --keep`) and repair from it with normal commands. Never restore over live orders |
| Background work failing after the release       | Effects go dead and stay; roll back the worker image, then `pnpm ops:effects` and replay after the fix                                                                                                |
| Checkout must stop now                          | Set `CHECKOUT_SUBMISSION_ENABLED=false` and redeploy the API: browsing continues, new orders are refused cleanly                                                                                      |

The step-128 rehearsal proves these on staging with real digests.

## Graceful stop

Stop admissions, drain requests/SSE, close worker after in-flight work, allow durable leases to expire/recover. Worker has a 20s hard deadline; later effect consumers must tolerate redelivery. Platform stop timeout must exceed the app deadline. Supervisor restart/backoff and health policy are chosen/tested with actual infrastructure.
