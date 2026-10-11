CREATE TABLE staff_invitation_tokens (
  id uuid PRIMARY KEY,
  email varchar(254) NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invited_by uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  key_id varchar(32) NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX staff_invitation_tokens_pending_email_idx ON staff_invitation_tokens(email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX staff_invitation_tokens_invited_by_idx ON staff_invitation_tokens(invited_by);
-- No in-place recipient/role/token edits: resend revokes and issues a new snapshot.
CREATE FUNCTION staff_invitation_snapshot_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF ROW(NEW.email, NEW.name, NEW.role_id, NEW.invited_by, NEW.token_hash, NEW.key_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.email, OLD.name, OLD.role_id, OLD.invited_by, OLD.token_hash, OLD.key_id, OLD.created_at, OLD.expires_at)
     OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'invitation snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_invitation_snapshot_immutable BEFORE UPDATE ON staff_invitation_tokens
  FOR EACH ROW EXECUTE FUNCTION staff_invitation_snapshot_immutable();
