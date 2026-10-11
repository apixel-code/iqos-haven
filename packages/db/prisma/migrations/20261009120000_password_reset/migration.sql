-- Additive identity migration. No secret token or reset URL is stored.
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  key_id varchar(32) NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  user_version integer NOT NULL CHECK (user_version >= 1),
  recipient_hash bytea NOT NULL CHECK (octet_length(recipient_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
