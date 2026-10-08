# Hosting and capacity handoff

BI-06 is open. This package does not select a provider, apply Terraform, publish a service, create billable resources or invent production addresses.

Before staging: record provider/region, budget versus replicated profile, compute limits, PostgreSQL connection budget/pooler semantics, queue Redis persistence/noeviction, private network/gateway/TLS routing, media storage/CDN policies, DNS, secret injection, CI deployment identity and monthly cost.

Budget profile: one storefront, one admin, one API and one worker deployment; dedicated noeviction queue Redis; bounded process caches and checkout limiter fallback. Separate cache Redis is required only when coordinating two or more replicas. Auth/reset strict policies remain separate from checkout availability policy.

Connection sizing: sum all API pools, worker pools, migrations/operations and headroom below PostgreSQL max_connections. Worker concurrency and lease timeouts must follow real provider latency and load evidence. Do not place an untested transaction-mode pooler in front of Prisma locking workflows.

Production infrastructure deliverables remain required: provider-specific IaC, separate staging/production state, immutable image digests, a single reviewed migration job, least-privilege runtime roles, private Nest routing, secret references, offsite backups/PITR, dashboards/alerts, tested rollback, restore drill and measured capacity. See deploy/backup runbooks for gates.

Estimate remains provisional: 14–18 weeks for two full-time developers, subject to inputs, scope and integration/acceptance evidence. Do not mark a publicly reachable foundation health page as a production release.
