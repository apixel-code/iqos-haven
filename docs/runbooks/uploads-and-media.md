# Uploads and media

How an image gets to the store: the admin asks the API for a signed upload, the browser puts the file into the private **quarantine** bucket, the API records it (`uploaded`) and a `media.uploaded` event is written. The worker's `media_processor` effect checks it, makes WebP derivatives into the private **media** bucket and marks the asset `ready` (or `rejected` with a reason). The storefront serves only `ready` derivatives. Every hour `media.quarantine_cleanup` deletes quarantine originals of expired, rejected and processed assets.

## An upload stays "processing"

1. Is the worker running (`docker compose ps`)? Is there an `effects.backlog` alert? Then follow the incident runbook: the reconciler re-enqueues from PostgreSQL once the worker and queue Redis are healthy.
2. `pnpm ops:effects --consumer media_processor`: a dead effect with `RETRY_EXHAUSTED:…` usually means object storage was unreachable. Check the storage endpoint and credentials (`STORAGE_*`), then replay: `pnpm ops:effects --replay <id> --reason "INC-n: storage back"`.
3. `MEDIA_ASSET_MISSING` / `INVALID_MEDIA_EVENT`: do not replay; ask the user to upload again and report the effect ID to Apixel.

## An upload was rejected

The admin shows the reason. These are final for that upload; the user uploads again:

| Reason               | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `too_large`          | Over the 8 MB limit                                                         |
| `object_missing`     | The file never reached quarantine, or expired before processing             |
| `object_changed`     | The stored file differs from the one the upload recorded (replaced mid-way) |
| `unsupported_format` | Not a JPEG, PNG or WebP                                                     |
| `type_mismatch`      | The file's real type differs from its name/declared type                    |
| `animated`           | Animated images are not accepted                                            |
| `decode_failed`      | The image could not be decoded (damaged file)                               |
| `too_many_pixels`    | Over 40 megapixels                                                          |

## Images missing on the store

1. In the admin, is the product image `ready` and the product published? A product without an image is flagged by `pnpm launch:check`.
2. Storage outage: images fail to load until storage is back; nothing to repair in the database, and they return without action.
3. Lost objects in the media bucket: restore them from the latest backup set (backup runbook; the drill puts the decrypted media in `BACKUP_DIR/drills/<db>/media`, keyed by `media-index.enc`). If an image is not in any backup, re-upload it in the admin.

## Storage credentials leaked

Create new keys at the storage provider limited to the three buckets, update the secret store, redeploy API and worker, confirm an upload reaches `ready`, then revoke the old keys. Buckets stay private; nothing is ever made public to "fix" images.
