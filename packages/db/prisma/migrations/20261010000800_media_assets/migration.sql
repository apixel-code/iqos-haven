-- Media uploads (roadmap step 48, ADR 0018). An authorized upload goes straight from the browser
-- into the private quarantine bucket under `uploads/<asset id>` with a POST policy that pins the
-- key, content type and size range. Nothing here is public: processing, derivatives and gallery
-- membership arrive in steps 49–50, and only `ready` assets can ever be attached to a product.
CREATE TABLE media_assets (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 uploaded_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 quarantine_key VARCHAR(512) NOT NULL UNIQUE CHECK (quarantine_key='uploads/' || id::text),
 declared_type VARCHAR(32) NOT NULL CHECK (declared_type IN ('image/jpeg','image/png','image/webp')),
 declared_bytes INTEGER NOT NULL CHECK (declared_bytes BETWEEN 1 AND 8388608),
 state VARCHAR(16) NOT NULL DEFAULT 'pending'
  CHECK (state IN ('pending','uploaded','processing','ready','rejected','expired')),
 observed_bytes INTEGER CHECK (observed_bytes BETWEEN 1 AND 8388608),
 observed_type VARCHAR(32),
 -- Storage ETag observed at completion; processing (step 49) must find the same object.
 observed_etag VARCHAR(128),
 width INTEGER CHECK (width BETWEEN 1 AND 20000),
 height INTEGER CHECK (height BETWEEN 1 AND 20000),
 sha256 CHAR(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 derivative_keys JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(derivative_keys)='object'),
 error VARCHAR(64) CHECK (error IS NULL OR error ~ '^[a-z][a-z0-9_]{0,63}$'),
 upload_expires_at TIMESTAMPTZ(6) NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 CHECK (state NOT IN ('uploaded','processing','ready') OR observed_bytes IS NOT NULL),
 CHECK (state<>'ready' OR (width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX media_assets_product ON media_assets(product_id, created_at, id);
-- Cleanup (step 49) finds stale pending/uploaded rows by state and authorization expiry.
CREATE INDEX media_assets_open ON media_assets(upload_expires_at)
 WHERE state IN ('pending','uploaded','processing');
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON media_assets FROM ih_app;
 END IF;
END;
$$;
