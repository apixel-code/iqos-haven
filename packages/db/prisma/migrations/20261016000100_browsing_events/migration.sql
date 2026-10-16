-- Anonymous browsing events (roadmap step 103, ADR 0069; architecture §5 "Analytics"). Best
-- effort, never commerce: no customer, IP, user agent or cookie is stored. The ID comes from
-- the client so a resent batch is counted once. Raw rows are kept 90 days (BI-08); the daily
-- tables (step 106) keep the totals.
CREATE TABLE events (
  id UUID PRIMARY KEY,
  type VARCHAR(24) NOT NULL,
  payload JSONB NOT NULL,
  -- A random ID the browser rotates (step 104); never linked to a customer or an order.
  anonymous_id UUID,
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT event_type CHECK (type IN
    ('search', 'product_view', 'cart_add', 'cart_remove', 'wishlist_add', 'wishlist_remove')),
  CONSTRAINT event_payload CHECK (jsonb_typeof(payload) = 'object'
    AND octet_length(payload::text) <= 512)
);
-- Rollups read a Dubai day of one type; cleanup reads the oldest rows.
CREATE INDEX events_type_time ON events (type, received_at);
CREATE INDEX events_time ON events (received_at);
-- Append-only for the runtime role; DELETE stays for the 90-day retention job.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, TRUNCATE ON events FROM ih_app;
 END IF;
END;
$$;
