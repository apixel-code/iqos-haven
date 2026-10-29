# 0100 — Staging on the shared Hostinger VPS: digest-pinned images, host nginx, localhost-only ports

- Date: 2026-10-28
- Status: accepted
- Step(s): roadmap step 122 (architecture §12, CI/CD sequence)

## Context

The Hostinger VPS (BI-06) exists: `srv1927335`, 1 vCPU, 3.8 GB RAM, 48 GB disk, Ubuntu 24.04, in **Kuala Lumpur, not the UAE**.

- It is shared with Apixel's own site, apixelpost.tech. That site uses host nginx on 80/443, a pm2 Node process and cron jobs, and its GitHub deploy logs in as root with a password.
- Marina (2026-10-28):
  - Iqos Haven **staging only** on this server.
  - No budget for more hosting now; production hosting is decided later.
  - apixelpost.tech must not be affected.
- `iqoshaven.com` is not registered yet, so staging uses subdomains of apixelpost.tech (Cloudflare DNS, records set to DNS only).

## Decision

- **Images.**
  - `infra/docker/Dockerfile` has five targets: `migrate`, `api`, `worker`, `storefront`, `admin`.
  - Base: Node 24 bookworm-slim, pinned by digest. Each image runs as the unprivileged `node` user, under `tini`, with production dependencies only.
  - The Next apps run their standalone output. `start.cjs` validates the environment at boot and strips the age-ticket private key from the admin process.
  - `.dockerignore` keeps `.env`, `.git`, `docs`, backups and build output out of the context.
- **Build once.**
  - `.github/workflows/images.yml` builds `linux/amd64` on every `main` commit and pushes to GHCR.
  - It publishes `release.env` (an artifact and the job summary) with the five `…@sha256:` digests.
  - The VPS never builds: its single vCPU is shared.
- **Staging stack** (`infra/staging/compose.yml`, project `ih-staging`):
  - Services: PostgreSQL 18, queue Redis (noeviction + AOF), MinIO, Mailpit, migrate (one-shot), api, worker, storefront, admin, and the same Caddy gateway as development.
  - Every published port is bound to `127.0.0.1`: gateway 8180/8181, MinIO 9100, Mailpit 8125. Docker bypasses ufw, so binding is the control. PostgreSQL, Redis and the API publish nothing.
  - App containers are read-only, with `no-new-privileges` and memory limits that keep apixelpost.tech responsive.
  - Each service gets its own env file, written on the server by `make-env.mjs` with fresh secrets. Only the storefront holds the age-ticket signing key. Only the migrate job holds the owner database URL.
  - PostgreSQL creates the separate runtime role from a generated password (`postgres-init.sh`).
- **Edge.**
  - The existing host nginx serves three hostnames: storefront, admin and media. TLS comes from Let's Encrypt via certbot.
  - nginx overwrites `X-Forwarded-For` with the TCP peer.
  - The Caddyfile now trusts that one hop: `GATEWAY_TRUSTED_PROXY`, the pinned Compose gateway `172.30.50.1`. It reads the client IP from it with `trusted_proxies_strict`. Locally the default matches nothing, so behaviour is unchanged.
  - The gateway test covers both cases.
  - This also fixes the client-IP placeholder (`{http.vars.client_ip}`). The old test only checked "not the spoofed value", so it would not have caught a literal placeholder.
- **Media.** Presigned GETs and POSTs need a browser-reachable https S3 endpoint, and staging/production require https. MinIO is published as `iqos-media-staging.apixelpost.tech`, and the API and worker use the same https endpoint. Buckets stay private.
- **Email.** Staging sends only to Mailpit on the server, and keeps the mandatory recipient allowlist. Nothing is delivered; staff read mail through an SSH tunnel.
- **Release** (`deploy.sh release.env`):
  1. Refuses images that are not pinned by digest.
  2. Pulls the images.
  3. Starts the state services and creates the buckets.
  4. Runs the reviewed migrations with the owner identity.
  5. Starts the api, then the worker, storefront, admin and gateway.
  6. Smoke-checks health and that the storefront hides the admin API.
  - It never removes volumes.
- **Host hardening (done 2026-10-28, not in the repository):**
  - 2 GB swap;
  - fail2ban for sshd;
  - ufw allows only 22/80/443, which also closes the formerly public :3001;
  - unattended security upgrades were already on.
  - SSH password login stays on until apixelpost's deploy uses a key.

## Consequences

- **Residency.** Staging data lives in Malaysia. Staging holds test data only and never real customers. Production still needs the residency decision (architecture §11).
- **Not the launch profile.** The architecture's budget profile assumes a UAE host and managed PostgreSQL. This box is shared, 1 vCPU, with no Cloudflare in front of the Iqos Haven hostnames. Load numbers from it are a lower bound, not production capacity.
- **Registry access.** The VPS pulls private GHCR images with a read-only (`read:packages`) token, held by the server's Docker login only.
- **Production.** Moving to production means: register `iqoshaven.com`, choose the host (a separate VPS, or Vercel for the two Next apps after an ADR covering same-origin `/api`, the age gate and SSE), and promote the same digests.
- **Follow-ups.** The daily backup timer, off-VPS copies and WAL archiving (RPO ≤5 min) are step 122b on this stack.
