# packages/platform — shared infrastructure adapters

- Object storage (S3-compatible: MinIO locally, provider per BI-06) and private service-to-service authentication. Used by apps only; domain/contracts/application must not import it (ESLint).
- Buckets are private. Access is through service credentials or short-lived presigned URLs (≤ 15 minutes). Never make a bucket or object public; public media is served from sanitized derivatives via CDN later.
- Object keys are generated server-side and validated (no `..`, no leading `/`, bounded charset/length). Never build a key from a client filename.
- Service auth: HMAC-SHA256 over method, path, timestamp, nonce and body hash; per-caller key ids for rotation; never accept an admin/shopper cookie as service identity. Log service id/key id only, never keys or signatures.
