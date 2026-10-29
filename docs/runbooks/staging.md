# Staging server (shared Hostinger VPS)

Design: ADR 0100. Server `187.52.125.232` (Kuala Lumpur). The same host runs apixelpost.tech (host nginx, pm2, cron): never stop nginx, change its other sites, or take ports 80/443. After any server change, `https://apixelpost.tech` must still answer 200.

| Hostname                             | Goes to                        |
| ------------------------------------ | ------------------------------ |
| `iqos-staging.apixelpost.tech`       | Caddy gateway → storefront/API |
| `iqos-admin-staging.apixelpost.tech` | Caddy gateway → admin/API      |
| `iqos-media-staging.apixelpost.tech` | MinIO S3 API (private buckets) |

Staging directory on the server: `/opt/iqos-staging`. It holds:

- `compose.yml`, `deploy.sh`, `make-env.mjs` and `postgres-init.sh`;
- `Caddyfile`, copied from `infra/gateway`;
- `init-buckets.sh`, copied from `infra/minio`;
- `env/`, with mode 0700, created on the server and never copied off it;
- `release.current.env`.

## First setup (once)

1. Point the DNS A records for the three hostnames at the server, set to DNS only, not proxied.
2. Copy `infra/staging/*`, `infra/gateway/Caddyfile` and `infra/minio/init-buckets.sh` into `/opt/iqos-staging`.
3. Write the env files on the server. The script prints no secrets and refuses to overwrite:

   ```sh
   node make-env.mjs --dir env --store https://iqos-staging.apixelpost.tech \
     --admin https://iqos-admin-staging.apixelpost.tech \
     --media https://iqos-media-staging.apixelpost.tech --mail-allow "<staff emails or @domains>"
   ```

4. Install the nginx sites and get the certificates:

   ```sh
   cp nginx-site.conf /etc/nginx/sites-available/iqos-staging
   ln -s ../sites-available/iqos-staging /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d <the three hostnames>
   ```

5. Log in to the registry with a token that has only `read:packages`: `docker login ghcr.io`.

## Release

1. Merge to `main`. The **Images** workflow pushes five images and shows `release.env`, with digests, in its summary.
2. Put that file on the server as `releases/<sha>.env` and run `./deploy.sh releases/<sha>.env`.
3. Exit 0 means migrations were applied, every service is healthy and the smoke checks passed.

**Roll back:** run `./deploy.sh` with the previous release file. This works only while the schema is compatible (deploy-and-rollback.md).

## Operator commands on staging

Run these from `/opt/iqos-staging` with `C="docker compose --env-file release.current.env"`:

| Task                      | Command                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| First Owner               | `$C run --rm --no-deps api node dist/cli/bootstrap-owner.main.js --email <a> --name "<n>"` |
| Launch readiness          | `$C run --rm --no-deps api node dist/cli/launch-check.main.js`                             |
| Dead effects              | `$C run --rm --no-deps worker node dist/cli/effects.main.js`                               |
| Status / logs             | `$C ps`, `$C logs --tail 200 <service>`                                                    |
| Read staging email        | `ssh -L 8125:127.0.0.1:8125 root@187.52.125.232`, then open http://localhost:8125          |
| Checkout on (test orders) | set `CHECKOUT_SUBMISSION_ENABLED=true` in `env/api.env`, then `$C up -d api`               |

Never run `docker compose down -v` or `docker volume rm` here: it deletes the staging database and media.
