-- Staff notification inbox (roadmap step 78, ADR 0047; architecture §8 "Notification inbox").
-- A notification is written once per source event and type; each eligible staff user gets a
-- receipt of their own. Reading changes only that user's receipt.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  -- The outbox event this was made from. Not a foreign key: completed events are pruned after
  -- their recovery window, and a notification must outlive that.
  source_event_id UUID NOT NULL,
  type VARCHAR(64) NOT NULL,
  -- Operational wording only: an order number, a count, a total. Never a customer's name,
  -- phone or address.
  title VARCHAR(150) NOT NULL,
  body VARCHAR(500) NOT NULL,
  -- A path inside the admin, never an absolute URL.
  link VARCHAR(300),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notifications_source UNIQUE (source_event_id, type),
  CONSTRAINT notification_type CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT notification_title CHECK (btrim(title) <> ''),
  CONSTRAINT notification_link CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_-]*$')
);
CREATE INDEX notifications_created ON notifications (created_at);
CREATE FUNCTION notifications_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A notification is never changed or removed' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER notifications_immutable BEFORE UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_immutable();

-- Who was told. The recipients are those who were eligible when the event was handled; a
-- later role change neither adds nor removes a receipt.
CREATE TABLE notification_receipts (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  delivered_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  read_at TIMESTAMPTZ(6),
  PRIMARY KEY (notification_id, user_id),
  CONSTRAINT notification_receipt_read CHECK (read_at IS NULL OR read_at >= delivered_at)
);
-- A user's inbox, unread first.
CREATE INDEX notification_receipts_inbox ON notification_receipts (user_id, read_at, notification_id);
CREATE FUNCTION notification_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A notification receipt is never removed' USING ERRCODE='42501';
  END IF;
  -- Only "read" may change, and only once.
  IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'A notification receipt only records being read, once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_receipts_guard BEFORE UPDATE OR DELETE ON notification_receipts
  FOR EACH ROW EXECUTE FUNCTION notification_receipts_guard();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, DELETE, TRUNCATE ON notifications, notification_receipts FROM ih_app;
  -- A receipt changes in one way: it is read.
  GRANT UPDATE (read_at) ON notification_receipts TO ih_app;
 END IF;
END;
$$;
