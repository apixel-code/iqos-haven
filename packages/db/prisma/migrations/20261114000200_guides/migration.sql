-- Guides (ADR 0117, SEO plan 2026-11-13): articles the Owner writes in the admin and the store
-- shows under /guides. Plain text with a small markup checked by the API (`readGuideBody`).
-- A guide is never deleted: it is hidden (published=false) and keeps its first publish date.
--
-- Expand only: a new table. The previous release does not know it.
CREATE TABLE guides (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  slug VARCHAR(120) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title VARCHAR(120) NOT NULL CHECK (title = btrim(title) AND length(title) > 0),
  summary VARCHAR(300) NOT NULL CHECK (summary = btrim(summary) AND length(summary) > 0),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 30000),
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT guides_published_has_date CHECK (NOT published OR published_at IS NOT NULL)
);
-- The store lists published guides, newest first.
CREATE INDEX guides_published ON guides (published_at DESC, id DESC) WHERE published;
CREATE INDEX guides_updated_by ON guides (updated_by);
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON guides FROM ih_app;
 END IF;
END;
$$;
