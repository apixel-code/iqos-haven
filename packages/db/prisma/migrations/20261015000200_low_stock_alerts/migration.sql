-- Low-stock alert quiet window (roadmap step 92, ADR 0060). One row per variant and channel:
-- the event that last alerted and when. A newer crossing inside the quiet window alerts nobody,
-- so stock that bounces around its alert level does not repeat the same alert.
CREATE TABLE low_stock_alerts (
  variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  channel VARCHAR(16) NOT NULL,
  source_event_id UUID NOT NULL,
  alerted_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (variant_id, channel),
  CONSTRAINT low_stock_alert_channel CHECK (channel IN ('inbox', 'email'))
);
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON low_stock_alerts FROM ih_app;
 END IF;
END;
$$;
