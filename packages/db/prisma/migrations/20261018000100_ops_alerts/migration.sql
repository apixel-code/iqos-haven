-- Operational alert state (roadmap step 125, ADR 0096). One row per alert rule, written only by the
-- worker's monitor: whether it is firing, how many checks in a row found it, and when the operator
-- was last told. Kept in PostgreSQL because the queue Redis may be the failing component. Summaries
-- hold counts and durations only, never personal data.
CREATE TABLE ops_alerts (
  key VARCHAR(64) PRIMARY KEY,
  firing BOOLEAN NOT NULL DEFAULT false,
  consecutive INTEGER NOT NULL DEFAULT 0,
  summary VARCHAR(300),
  opened_at TIMESTAMPTZ(6),
  last_notified_at TIMESTAMPTZ(6),
  resolved_at TIMESTAMPTZ(6),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT ops_alerts_key CHECK (key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  CONSTRAINT ops_alerts_consecutive CHECK (consecutive >= 0),
  CONSTRAINT ops_alerts_open CHECK (NOT firing OR opened_at IS NOT NULL)
);
