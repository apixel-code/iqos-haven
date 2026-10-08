-- CreateTable
CREATE TABLE "scheduled_runs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_name" VARCHAR(64) NOT NULL,
    "slot" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "scheduled_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_runs_job_name_slot_key" ON "scheduled_runs"("job_name", "slot");

-- Hand-written (reviewed).
ALTER TABLE "scheduled_runs"
  ADD CONSTRAINT "scheduled_runs_job_name_ck" CHECK ("job_name" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  ADD CONSTRAINT "scheduled_runs_status_ck" CHECK ("status" IN ('pending', 'running', 'completed', 'failed')),
  ADD CONSTRAINT "scheduled_runs_attempts_ck" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "scheduled_runs_lease_ck" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  ADD CONSTRAINT "scheduled_runs_running_ck" CHECK ("status" <> 'running' OR "lease_owner" IS NOT NULL),
  ADD CONSTRAINT "scheduled_runs_released_ck" CHECK ("status" NOT IN ('completed', 'failed') OR "lease_owner" IS NULL),
  ADD CONSTRAINT "scheduled_runs_done_ck" CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT "scheduled_runs_failed_ck" CHECK ("status" <> 'failed' OR "last_error" IS NOT NULL);

-- Scheduler: runnable slots per job in slot order.
CREATE INDEX "scheduled_runs_due_idx" ON "scheduled_runs" ("job_name", "slot")
  WHERE "status" IN ('pending', 'running');

-- A slot runs to completion once: completed is terminal and rows are never deleted directly
-- (pruning of old completed slots comes with the BI-08 retention procedure).
CREATE FUNCTION "scheduled_runs_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scheduled runs are not deleted directly' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."id", NEW."job_name", NEW."slot", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."job_name", OLD."slot", OLD."created_at") THEN
    RAISE EXCEPTION 'scheduled run identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'completed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed scheduled run is terminal' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."updated_at" := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "scheduled_runs_guard"
  BEFORE UPDATE OR DELETE ON "scheduled_runs"
  FOR EACH ROW EXECUTE FUNCTION "scheduled_runs_guard"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
    REVOKE DELETE, TRUNCATE ON "scheduled_runs" FROM ih_app;
  END IF;
END;
$$;
