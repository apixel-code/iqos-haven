-- Idempotency ledger (roadmap step 74, ADR 0043). One row per accepted command key: who asked
-- (scope), a hash of the key, a hash of what was asked, and the answer to give again.
-- A row is written in the same transaction as the command's effects, so a rolled-back attempt
-- leaves nothing behind and may be tried again.
CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  scope VARCHAR(64) NOT NULL,
  -- SHA-256 of the key. The key is a bearer-like secret and is never stored or logged.
  key_hash BYTEA NOT NULL,
  payload_hash BYTEA NOT NULL,
  -- The sanitized answer replayed for the same key and payload. Set before commit.
  response JSONB,
  resource_type VARCHAR(32),
  resource_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  -- Until then the answer can be replayed; afterwards the key is still never accepted as new.
  expires_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT idempotency_records_key UNIQUE (scope, key_hash),
  CONSTRAINT idempotency_scope CHECK (scope ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT idempotency_hashes CHECK (
    octet_length(key_hash) = 32 AND octet_length(payload_hash) = 32),
  CONSTRAINT idempotency_response CHECK (response IS NULL
    OR (jsonb_typeof(response) = 'object' AND length(response::text) <= 16000)),
  CONSTRAINT idempotency_resource CHECK ((resource_type IS NULL) = (resource_id IS NULL)
    AND (resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_]{0,31}$')),
  CONSTRAINT idempotency_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
CREATE FUNCTION idempotency_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only an expired answer may be cleaned up.
    IF OLD.expires_at > statement_timestamp() THEN
      RAISE EXCEPTION 'An unexpired idempotency record cannot be removed' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'An idempotency record keeps its key, payload and expiry' USING ERRCODE='23514';
  END IF;
  -- The answer is written once.
  IF OLD.response IS NOT NULL AND (NEW.response IS DISTINCT FROM OLD.response
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id) THEN
    RAISE EXCEPTION 'An idempotency answer is written once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER idempotency_records_guard BEFORE UPDATE OR DELETE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION idempotency_records_guard();
-- A claim without an answer cannot be committed: a later replay would have nothing to return.
CREATE FUNCTION idempotency_records_answered() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT response IS NULL FROM idempotency_records WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'An idempotency claim must be answered before commit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER idempotency_records_answered AFTER INSERT ON idempotency_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idempotency_records_answered();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE TRUNCATE ON idempotency_records FROM ih_app;
 END IF;
END;
$$;
