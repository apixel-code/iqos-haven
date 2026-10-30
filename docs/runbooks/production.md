# Production go-live on the VPS

Design: ADR 0100 (production on the same VPS as staging, separate everything). Files: `infra/vps` with `site.production.env`. Do this on the day `iqoshaven.com` is registered, after staging has passed the release being promoted.

## Before (Marina / client)

- Upgrade the VPS to Hostinger KVM 2, then re-check memory (`free -h`, `docker stats`).
- Domain registered. DNS A records point at the server: `iqoshaven.com`, `admin.iqoshaven.com` and `media.iqoshaven.com`. Set them to DNS only while certificates are issued.
- Approved age-policy version (BI-04) and the client's WhatsApp number (BI-09).
- Email: a Resend account and the verified sender domain (BI-07). Production starts with email delivery off; checkout stays off until this is done.

## Steps (server, `/opt/iqos-production`)

1. Copy `infra/vps/*`, `infra/gateway/Caddyfile` and `infra/minio/init-buckets.sh` here, and copy `site.production.env` to `site.env`.
2. Generate the secrets on the server:

   ```sh
   node make-env.mjs --env production --store https://iqoshaven.com \
     --admin https://admin.iqoshaven.com --media https://media.iqoshaven.com \
     --age-policy <BI-04 version>
   ```

3. Check that production shares no secret with staging: `./check-isolation.sh /opt/iqos-staging /opt/iqos-production`. It must print `Isolated`.
4. Set up nginx and TLS:

   ```sh
   ./render-nginx.sh > /etc/nginx/sites-available/iqos-production
   ln -s ../sites-available/iqos-production /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d iqoshaven.com -d admin.iqoshaven.com -d media.iqoshaven.com
   ```

   apixelpost.tech must still answer 200 afterwards.

5. Release the **same** release file that passed on staging: `./deploy.sh releases/<sha>.env`.
6. Create the first Owner: `$C run --rm --no-deps api node dist/cli/bootstrap-owner.main.js --email <a> --name "<n>"`. Marina types the password.
7. Set up backups:
   - Run `./backup-env.sh` and `./pitr-env.sh`. Save both secrets in the password manager, labelled **production**.
   - Run `./basebackup.sh`.
   - Enable the timers: `systemctl enable --now ih-backup@production.timer ih-wal@production.timer ih-basebackup@production.timer`.
   - Run one `systemctl start ih-backup@production`.
   - Run a restore drill and a PITR drill.
8. Settings in the admin: store and contact details, delivery fee, WhatsApp number, indexing policy (BI-05), staff. Add the real catalogue. Never copy staging demo data.
9. Turn email on in `env/worker.env`:
   - set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM=no-reply@iqoshaven.com`, then `EMAIL_SEND_ENABLED=true`;
   - run `$C up -d worker` and `$C run --rm --no-deps worker node dist/cli/ops-test-alert.main.js`.
10. Run `pnpm launch:check`. In the api image this is `$C run --rm --no-deps api node dist/cli/launch-check.main.js`, and it must pass.
11. Then set `CHECKOUT_SUBMISSION_ENABLED=true` in `env/api.env` and run `$C up -d api`.
12. Once production is live, run staging only for test windows: `docker compose --env-file release.current.env stop` in `/opt/iqos-staging`, and `deploy.sh` to start it again.

`$C` means `docker compose --env-file release.current.env`, run from `/opt/iqos-production`.
