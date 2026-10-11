# 0018 — Quarantine media upload: signed POST policy, two short transactions

- Date: 2026-10-10
- Status: accepted
- Step(s): 48 (processing 49, gallery 50, cleanup 49)

## Context

Architecture §11 "Media upload" sets the rules for uploads:

- Each upload needs an authenticated authorization and a `media_assets` row.
- Uploads go into a private quarantine prefix.
- A signed POST policy with a content-length range is preferred; a PUT content-type header proves neither size nor type.
- Launch limits: eight images per product, 8 MB each.
- Only sanitized derivatives are published.

Step 26 provides `ObjectStorage.presignQuarantineUpload`. The policy it signs pins the exact key and the content type, and it enforces a size range. The root `CLAUDE.md` forbids network calls inside a DB transaction.

## Decision

**Table.** `media_assets` (migration `20261010000800_media_assets`) holds:

- the product and uploader;
- `quarantine_key = uploads/<asset id>`;
- the declared type (JPEG, PNG or WebP) and size (1 to 8,388,608 bytes);
- state: `pending`, `uploaded`, `processing`, `ready`, `rejected` or `expired`;
- observed bytes, type and dimensions, sha256, derivative keys and an error code (filled in by step 49);
- a 10-minute `upload_expires_at`;
- a version.

A `ready` asset requires dimensions and a hash. The runtime role cannot delete or truncate the table.

**Authorization:** `POST /v1/admin/products/:id/media/uploads` with `{ contentType, bytes }`, requiring `catalog.write` and `media.upload`. It runs one transaction:

1. Lock the actor, then lock the product `FOR UPDATE`. This serializes the eight-slot limit.
2. Return 404 for an unknown product, and `TRASHED` for a trashed one.
3. Return `IMAGE_LIMIT` when eight slots are taken. A slot is taken by an uploaded, processing or ready asset, or by a pending one that has not expired.
4. Insert the pending row (its id comes from DB-clock UUIDv7) and write the audit.

After commit, the API signs the POST policy. Signing is local and makes no network call. The policy never outlives the database authorization: its lifetime is the remaining seconds by the DB clock. If signing fails, the pending row is marked `rejected` (`presign_failed`) so it does not hold a slot. The policy allows at most the declared bytes and exactly the declared type, and lives 10 minutes. The response carries the asset and `{ url, fields }`, and the browser posts the file straight to private storage. The media bucket is never involved.

**Completion:** `POST /v1/admin/media/:assetId/complete`.

1. The API checks permissions, reads the key, and runs a HEAD on the quarantine object, outside any transaction.
2. A short transaction then locks the asset and decides:
   - A non-pending asset is returned unchanged, so a repeated completion is idempotent.
   - An expired authorization gets `UPLOAD_EXPIRED`.
   - A missing object gets `UPLOAD_MISSING`.
   - An object larger than declared or of a different type is marked `rejected` (`size_mismatch` or `type_mismatch`).
   - An asset whose product has since been trashed gets `TRASHED`.
   - Otherwise the asset becomes `uploaded`, with the observed bytes and the storage ETag recorded.
3. Audit is written, and on success the IDs-only `media.uploaded` event for the processing consumer (step 49) is written in the same transaction.

**Listing:** `GET /v1/admin/products/:id/media` requires `catalog.read`. A pending authorization past its expiry reads as `expired`.

Incomplete uploads are never published: only `ready` assets can become product images (step 50), and nothing in the quarantine bucket is public.

**Browser-facing endpoint and credentials.**

- Presigned URLs are signed against `S3_PUBLIC_ENDPOINT` when it is set (defaults to `S3_ENDPOINT`), so an internal service host never reaches the browser.
- The signed fields include the access key ID (never the secret). In production that key must belong to a dedicated identity limited to PutObject and HeadObject on the quarantine bucket under `uploads/*`. It must not be the identity that writes the public media bucket (BI-06).
- Completion is not scoped to the uploader: any caller with `catalog.write` and `media.upload` may complete any pending asset. This matches the global launch roles.

## Alternatives considered

- **Presigned PUT:** it cannot enforce size, and its content-type header proves nothing.
- **Uploading through the API:** big bodies would cross the gateway (64 KB limit), the API would buffer them, and the API process would see unprocessed bytes.
- **Holding a transaction across signing or HEAD:** this breaks the no-network-in-transaction rule, and locks would be held during storage latency.

## Consequences

- Step 49 (`MediaConsumer`) validates the actual bytes: magic numbers, dimensions and pixel bombs. It strips metadata, re-encodes with Sharp, writes derivatives to the media bucket, and sets `ready` or `rejected`.
  - Step 49 MUST compare the object's ETag with `observed_etag` before trusting the bytes. The POST policy stays valid until it expires, so a client could replace the object after completion. Alternatively, it copies the object to a processing key first.
  - Step 49 also runs a durable cleanup job for expired authorizations and their quarantine objects (marking them `expired`), for rejected objects, and for orphans.
- Step 50 builds the gallery UI. Browser uploads need CORS on the quarantine bucket for the admin origin; storage setup is BI-06. The admin CSP must also allow the storage origin for form POSTs.
- Event version: the `media.uploaded` aggregate version is the asset version after completion (2).
