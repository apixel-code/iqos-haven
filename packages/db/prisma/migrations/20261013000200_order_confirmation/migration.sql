-- Additive, separately encrypted capability replay material; JSON answers remain sanitized.
ALTER TABLE idempotency_records ADD COLUMN replay_cookie_material BYTEA,
 ADD COLUMN replay_cookie_expires_at TIMESTAMPTZ(6),
 ADD CONSTRAINT idempotency_cookie_pair CHECK (
   (replay_cookie_material IS NULL)=(replay_cookie_expires_at IS NULL)
   AND (replay_cookie_material IS NULL OR (scope='store.checkout' AND resource_type='order'
     AND resource_id IS NOT NULL AND octet_length(replay_cookie_material) BETWEEN 1 AND 256
     AND replay_cookie_expires_at>created_at AND replay_cookie_expires_at<=expires_at)));
CREATE INDEX idempotency_cookie_expiry ON idempotency_records(replay_cookie_expires_at)
 WHERE replay_cookie_material IS NOT NULL;
CREATE FUNCTION idempotency_cookie_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.response IS NOT NULL AND
   (NEW.replay_cookie_material IS DISTINCT FROM OLD.replay_cookie_material OR
    NEW.replay_cookie_expires_at IS DISTINCT FROM OLD.replay_cookie_expires_at) AND NOT COALESCE(
   (OLD.replay_cookie_expires_at<=statement_timestamp() AND
    NEW.replay_cookie_material IS NULL AND NEW.replay_cookie_expires_at IS NULL), false) THEN
   RAISE EXCEPTION 'Confirmation replay material is written once and cleared after expiry' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER idempotency_cookie_guard BEFORE UPDATE ON idempotency_records
 FOR EACH ROW EXECUTE FUNCTION idempotency_cookie_guard();
