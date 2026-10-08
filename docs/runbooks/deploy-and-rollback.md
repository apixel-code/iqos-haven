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

## Graceful stop

Stop admissions, drain requests/SSE, close worker after in-flight work, allow durable leases to expire/recover. Worker has a 20s hard deadline; later effect consumers must tolerate redelivery. Platform stop timeout must exceed the app deadline. Supervisor restart/backoff and health policy are chosen/tested with actual infrastructure.
