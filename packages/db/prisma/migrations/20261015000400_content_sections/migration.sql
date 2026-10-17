-- Storefront content (roadmap step 96, ADR 0064; architecture §5 "Marketing"). Seven fixed,
-- schema-defined home sections. Each row keeps a validated draft and the published copy; the
-- published copy is always an earlier draft, taken whole when the Owner publishes. There is no
-- free HTML and no page builder: the JSON shape is the contract's, per schema version.
CREATE TABLE content_sections (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  key VARCHAR(32) NOT NULL,
  schema_version INTEGER NOT NULL,
  draft JSONB NOT NULL,
  draft_updated_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  draft_updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  published JSONB,
  published_schema_version INTEGER,
  published_by UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  published_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT content_sections_key UNIQUE (key),
  CONSTRAINT content_section_key CHECK (key IN
    ('ticker', 'hero', 'featured', 'best_sellers', 'brands', 'campaign_banner', 'offers')),
  CONSTRAINT content_section_schema CHECK (schema_version > 0),
  CONSTRAINT content_section_draft CHECK (jsonb_typeof(draft) = 'object'
    AND octet_length(draft::text) <= 32768),
  CONSTRAINT content_section_published CHECK (
    (published IS NULL) = (published_schema_version IS NULL)
    AND (published IS NULL) = (published_by IS NULL)
    AND (published IS NULL) = (published_at IS NULL)
    AND (published IS NULL OR jsonb_typeof(published) = 'object')),
  CONSTRAINT content_section_version CHECK (version > 0)
);

CREATE FUNCTION content_sections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A content section is never removed' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.published IS NOT NULL THEN
      RAISE EXCEPTION 'A content section starts as an unpublished draft' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A content change keeps its section and advances the version by one'
      USING ERRCODE='23514';
  END IF;
  -- Publishing copies the current draft whole, at its schema version, and records who and when.
  -- Once published, a section stays published (a section is hidden through its own fields).
  IF NEW.published IS DISTINCT FROM OLD.published
     OR NEW.published_schema_version IS DISTINCT FROM OLD.published_schema_version
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
    IF NEW.published IS NULL OR NEW.published <> NEW.draft
       OR NEW.published_schema_version <> NEW.schema_version
       OR NEW.published_at IS NOT DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'Publishing copies the current draft' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_sections_guard BEFORE INSERT OR UPDATE OR DELETE ON content_sections
  FOR EACH ROW EXECUTE FUNCTION content_sections_guard();

-- Content images (hero, campaign banners) are media assets that belong to no product.
-- Pre-launch: every existing asset is a product asset, which the default keeps.
ALTER TABLE media_assets ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'product';
ALTER TABLE media_assets ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE media_assets ADD CONSTRAINT media_asset_purpose CHECK (
  purpose IN ('product', 'content') AND (purpose = 'product') = (product_id IS NOT NULL));
CREATE INDEX media_assets_content ON media_assets (created_at, id) WHERE purpose = 'content';

-- A content image used by a published section stays a `ready` content image (like a gallery
-- image stays on its product).
CREATE FUNCTION media_assets_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state <> 'ready' OR NEW.purpose <> 'content' OR NEW.product_id IS NOT NULL) AND EXISTS (
       SELECT 1 FROM content_sections s
       WHERE s.published @? ('$.**.assetId ? (@ == "' || OLD.id::text || '")')::jsonpath) THEN
    RAISE EXCEPTION 'A published content image must stay ready' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_assets_content_guard BEFORE UPDATE OF state, purpose, product_id ON media_assets
  FOR EACH ROW WHEN (OLD.state = 'ready' AND OLD.purpose = 'content')
  EXECUTE FUNCTION media_assets_content_guard();

DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON content_sections FROM ih_app;
 END IF;
END;
$$;
