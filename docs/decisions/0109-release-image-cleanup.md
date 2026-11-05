# 0109 — Release image clean-up

- Status: Accepted
- Date: 2026-11-05
- Decided by: Marina

## Context

The client's VPS has a 50 GB disk, and on 2026-11-05 it had 37 GB in use. Docker images took 35.1 GB: 72 images, of which only 9 were in use. Each release pulls six app images (migrate, api, worker, storefront, admin and ops), about 3 GB in all. `deploy.sh` never removed them, so 11 releases had piled up. Everything else, including the database, media, logs and backups, used under 1 GB. Staging and production share one Docker daemon on the same host.

## Decision

After a good release, `infra/vps/deploy.sh` removes this app's old images:

- **Kept:** every image a container on the host uses, running or stopped, in any project. The check uses the full image ID, so the other environment is safe.
- **Kept:** the images named in the newest `IH_KEEP_RELEASES` release files in `releases/` (default 2: this release and the one before, for a rollback).
- **Candidates:** only `ghcr.io/apixel-code/iqos-haven-*` images. Postgres, Redis, MinIO, Caddy and Mailpit are never touched.
- `docker rmi` runs without force, so Docker itself also refuses to remove an image in use.
- A clean-up failure prints a note and never fails the release.

## Consequences

- With two releases kept, the app images use about 6 GB instead of growing about 3 GB per release.
- The first release after this change removes the backlog: a dry run on the server counted 54 of 66 app images to remove (about 26 GB).
- Rolling back further than the kept releases still works: the release file pins images by digest, and `deploy.sh` pulls them again from GHCR.
- The server copies `/opt/iqos-staging/deploy.sh` and `/opt/iqos-production/deploy.sh` are updated from the repository, as the runbook already describes.
