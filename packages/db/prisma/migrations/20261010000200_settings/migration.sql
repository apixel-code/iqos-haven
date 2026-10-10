CREATE TABLE settings (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT settings_key CHECK (key IN ('store', 'contact', 'notifications', 'whatsapp')),
  CONSTRAINT settings_version CHECK (version > 0),
  CONSTRAINT settings_value_object CHECK (jsonb_typeof(value) IN ('object', 'null'))
);
-- Key identifies a configuration aggregate; updates cannot move its audit/event identity.
CREATE FUNCTION settings_immutable_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN RAISE EXCEPTION 'Settings key is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settings_immutable_key BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION settings_immutable_key();
-- No seed values: client-approved identities/contact/recipients/templates are still pending.
