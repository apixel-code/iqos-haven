# 0019 — Media processing: Sharp derivatives, ETag-pinned originals, durable quarantine cleanup

- Date: 2026-10-10
- Status: accepted
- Step(s): 49 (gallery 50)

## Context

Architecture §11 sets the rules for uploaded media. The decoder must verify magic bytes and confirm it supports the format. The policy rejects unsupported SVG, animated or malformed formats. Processing must resist decompression bombs, strip metadata and re-encode with Sharp. Only sanitized derivatives are published. Originals stay private with short retention. A durable job cleans up expired and orphan uploads.

ADR 0018 records the observed ETag at completion. It also requires processing to refuse bytes that changed afterwards, because the POST policy stays valid until it expires. Marina approved adding Sharp (2026-10-10).

## Decision

**Validation and derivatives** live in `@ih/platform` `processImage`, using Sharp 0.35.5 with exact pins in platform and worker.

Input checks, in order:

- **Size:** at most 8 MiB.
- **Container:** the magic bytes must be JPEG, PNG or WebP and must match the declared type. Anything else, including SVG and GIF, is `unsupported_format` or `type_mismatch`.
- **Decoder agreement:** the decoder must report the same format.
- **Decoder settings:** `limitInputPixels` = 40 MP and `failOn: "warning"`, the strictest setting, so truncation or bad CRCs are refused.
- **Shape:** animated input is rejected: either `pages > 1`, or a PNG whose chunks declare `acTL` before the image data (APNG). The displayed sides, after EXIF orientation, must be between 200 and 8000 px, and the total pixel count is bounded.
- **Decoding:** any decode failure is `decode_failed`.

Output: three WebP derivatives — large 1600, medium 800 and thumb 320 on the longest side, never enlarged.

- Orientation is applied, and no metadata (EXIF, ICC, comments) is written.
- The sha256 of the original is recorded.
- `sharp.cache(false)` is set, and the worker runs `sharp.concurrency(1)`.

**Consumer:** `media.uploaded` now requires the `media_processor` consumer.

- **Backfill:** step 48 already published `media.uploaded` with no required consumer, so those events completed immediately. Their completion is not redefined. Instead, migration `20261010000900` runs `media_backfill_processing()`, which gives every asset still `uploaded` without a processor effect a fresh event plus effect. The function is idempotent and stays callable by operations (`backfillMediaProcessing`).
- **Handler type:** it is an external effect handler. Storage I/O runs outside any transaction under the effect lease (heartbeats).
- **Skips:** an asset that is no longer `uploaded` is skipped.
- **Rejections before decoding:** a missing quarantine object is rejected as `object_missing`. An ETag that differs from `observed_etag` is rejected as `object_changed`.
- **Read limit:** the read is capped at 8 MiB (`too_large`).
- **Writes:** derivatives go to the private media bucket under deterministic keys, `products/<product>/<asset>/<size>.webp`, so a retry overwrites the same objects.
- **Recording:** one short transaction records `ready` (dimensions, sha256, derivative keys) or `rejected` (error code), only while the asset is still `uploaded`. The audit is attributed to the system actor. A redelivered effect is therefore a no-op.
- **Errors:** transient storage errors retry, with at most 5 attempts.

**Cleanup:** the durable scheduled job `media.quarantine_cleanup` runs hourly through `scheduled_runs` with catch-up of 1.

1. It marks pending authorizations past their expiry as `expired`.
2. It deletes quarantine originals and sets `quarantine_purged_at` (migration `20261010000900_media_processing`):
   - for expired and rejected assets, once their upload policy can no longer write, plus a 1-hour grace period for clock differences between storage and the database;
   - for ready assets, after 24 hours of retention.
3. It works in batches. A failing object is skipped for the rest of the run and retried next hour, so it never blocks the others.

Deleting an absent object is harmless, so the job is idempotent. Rows remain as history. No orphan objects can exist without a row, because keys are derived from committed rows and signing happens after commit. A bucket lifecycle rule on `uploads/` is still recommended as a backstop (BI-06).

**Publication:** derivatives are written to the private media bucket. Making them reachable (CDN or signed links) and attaching them to the product gallery belong to step 50. Nothing is public yet.

## Alternatives considered

- **Processing inside the API request:** this would put a CPU and memory heavy decoder on the request path.
- **Trusting `file-type` libraries only:** the decoder must agree too, otherwise polyglot files pass.
- **Keeping originals indefinitely:** this retains EXIF and location data longer than needed. The architecture asks for short retention.

## Consequences

- Step 50 lists only `ready` assets as gallery images, enforces at most eight published images with one primary, and serves derivatives only.
- Production sizing must account for Sharp memory: around 40 MP decoded per job at concurrency 1.
