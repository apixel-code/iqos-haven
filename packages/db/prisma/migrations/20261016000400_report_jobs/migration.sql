-- Report jobs (roadmap step 110, ADR 0076; architecture §5 `report_jobs`, §10 CSV reports).
-- Every export request is one row, owned by the staff member who asked. A small export is
-- streamed on download (`delivery='stream'`, ready at once, valid 15 minutes); a large one is
-- built by the worker into a private file (`delivery='file'`, step 112) and kept 7 days.
-- Rows are never deleted: an expired job keeps its record, only its file goes.
CREATE TABLE report_jobs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  type VARCHAR(16) NOT NULL,
  params JSONB NOT NULL,
  delivery VARCHAR(8) NOT NULL,
  status VARCHAR(16) NOT NULL,
  requested_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The rights a download needs, checked again then (the requester's at that moment).
  required_permissions TEXT[] NOT NULL,
  command_id UUID NOT NULL,
  estimated_rows INTEGER NOT NULL,
  artifact_key VARCHAR(300),
  row_count INTEGER,
  byte_size BIGINT,
  error_code VARCHAR(64),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  started_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  expires_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT report_jobs_command UNIQUE (requested_by, command_id),
  CONSTRAINT report_jobs_type CHECK (type IN ('sales','orders','products','inventory','customers')),
  CONSTRAINT report_jobs_params CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) <= 1024),
  CONSTRAINT report_jobs_delivery CHECK (
    (delivery = 'stream' AND status IN ('ready','expired') AND expires_at IS NOT NULL)
    OR (delivery = 'file' AND status IN ('queued','running','completed','failed','expired'))),
  CONSTRAINT report_jobs_completed CHECK (status <> 'completed'
    OR (artifact_key IS NOT NULL AND row_count IS NOT NULL AND completed_at IS NOT NULL
        AND expires_at IS NOT NULL)),
  CONSTRAINT report_jobs_failed CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CONSTRAINT report_jobs_permissions CHECK (cardinality(required_permissions) BETWEEN 1 AND 4),
  CONSTRAINT report_jobs_values CHECK (estimated_rows >= 0 AND attempts >= 0
    AND (row_count IS NULL OR row_count >= 0) AND (byte_size IS NULL OR byte_size >= 0))
);
-- The requester's own list, newest first; the worker's queue.
CREATE INDEX report_jobs_requester ON report_jobs (requested_by, created_at DESC, id DESC);
CREATE INDEX report_jobs_open ON report_jobs (created_at) WHERE status IN ('queued','running');

-- Who asked, what and with which parameters never changes after the request.
CREATE FUNCTION report_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.delivery IS DISTINCT FROM OLD.delivery OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.required_permissions IS DISTINCT FROM OLD.required_permissions
     OR NEW.command_id IS DISTINCT FROM OLD.command_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.estimated_rows IS DISTINCT FROM OLD.estimated_rows THEN
    RAISE EXCEPTION 'report request fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('completed','failed','expired') AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status IN ('completed','failed') AND NEW.status = 'expired') THEN
    RAISE EXCEPTION 'finished report job cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  -- A finished file is what was built: its key and size never change afterwards.
  IF OLD.status IN ('completed','expired') AND (NEW.artifact_key IS DISTINCT FROM OLD.artifact_key
     OR NEW.row_count IS DISTINCT FROM OLD.row_count OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'finished report file is immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER report_jobs_guard BEFORE UPDATE ON report_jobs
  FOR EACH ROW EXECUTE FUNCTION report_jobs_guard();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON report_jobs FROM ih_app;
 END IF;
END;
$$;
