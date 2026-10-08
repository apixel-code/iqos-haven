-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_type" VARCHAR(64) NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" VARCHAR(128) NOT NULL,
    "aggregate_version" BIGINT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "dispatched_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_effects" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" UUID NOT NULL,
    "consumer" VARCHAR(64) NOT NULL,
    "payload_ref" VARCHAR(256),
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "queued_at" TIMESTAMPTZ(6),
    "replays" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(500),
    "external_receipt" VARCHAR(256),
    "skip_reason" VARCHAR(500),

    CONSTRAINT "consumer_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_created_at_idx" ON "outbox_events"("aggregate_type", "aggregate_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_effects_event_id_consumer_key" ON "consumer_effects"("event_id", "consumer");

-- AddForeignKey
ALTER TABLE "consumer_effects" ADD CONSTRAINT "consumer_effects_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (reviewed): shape constraints mirror @ih/contracts event catalogue validation.
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_type_ck" CHECK ("event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "outbox_events_schema_version_ck" CHECK ("schema_version" > 0),
  ADD CONSTRAINT "outbox_events_aggregate_type_ck" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "outbox_events_aggregate_id_ck" CHECK (length("aggregate_id") > 0),
  ADD CONSTRAINT "outbox_events_aggregate_version_ck" CHECK ("aggregate_version" IS NULL OR "aggregate_version" >= 0),
  -- Events carry IDs, never whole customer/order documents. jsonb text adds whitespace, so this
  -- bound is slightly stricter than the JSON.stringify bound in @ih/contracts defineEvent().
  ADD CONSTRAINT "outbox_events_payload_ck" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096
  ),
  ADD CONSTRAINT "outbox_events_attempts_ck" CHECK ("dispatch_attempts" >= 0),
  ADD CONSTRAINT "outbox_events_lease_ck" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL));

ALTER TABLE "consumer_effects"
  -- Names are validated against the catalogue by the writer; the database bounds their shape.
  ADD CONSTRAINT "consumer_effects_consumer_ck" CHECK ("consumer" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "consumer_effects_status_ck" CHECK (
    "status" IN ('pending', 'queued', 'running', 'retry', 'completed', 'dead', 'skipped')
  ),
  ADD CONSTRAINT "consumer_effects_attempts_ck" CHECK ("attempts" >= 0 AND "replays" >= 0),
  ADD CONSTRAINT "consumer_effects_lease_ck" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  ADD CONSTRAINT "consumer_effects_running_ck" CHECK ("status" <> 'running' OR "lease_owner" IS NOT NULL),
  -- Finished or dead work holds no lease, so the reconciler never mistakes it for live work.
  ADD CONSTRAINT "consumer_effects_released_ck" CHECK (
    "status" NOT IN ('completed', 'skipped', 'dead') OR "lease_owner" IS NULL
  ),
  ADD CONSTRAINT "consumer_effects_queued_ck" CHECK ("status" <> 'queued' OR "queued_at" IS NOT NULL),
  ADD CONSTRAINT "consumer_effects_done_ck" CHECK (
    ("status" IN ('completed', 'skipped')) = ("completed_at" IS NOT NULL)
  ),
  -- A skip is an intentional, audited decision, never a silent success.
  ADD CONSTRAINT "consumer_effects_skip_ck" CHECK (("status" = 'skipped') = ("skip_reason" IS NOT NULL)),
  -- Dead effects stay investigable.
  ADD CONSTRAINT "consumer_effects_dead_ck" CHECK ("status" <> 'dead' OR "last_error" IS NOT NULL);

-- Relay: undispatched events in creation order. Reconciler: incomplete events (dispatched or not).
CREATE INDEX "outbox_events_undispatched_idx" ON "outbox_events" ("created_at", "id")
  WHERE "dispatched_at" IS NULL AND "completed_at" IS NULL;
CREATE INDEX "outbox_events_incomplete_idx" ON "outbox_events" ("created_at", "id")
  WHERE "completed_at" IS NULL;
CREATE INDEX "consumer_effects_due_idx" ON "consumer_effects" ("due_at", "id")
  WHERE "status" IN ('pending', 'retry');
-- Reconciler: queued/running work whose lease/heartbeat may have been lost with Redis.
CREATE INDEX "consumer_effects_active_idx" ON "consumer_effects" ("status", "updated_at", "id")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX "consumer_effects_dead_idx" ON "consumer_effects" ("updated_at", "id")
  WHERE "status" = 'dead';

-- Event identity and payload are immutable; only relay bookkeeping may change.
-- An event completes only when every snapshotted effect is completed or skipped (dead is not success).
-- Deleting is only for pruning completed events, after their effects were pruned.
CREATE FUNCTION "outbox_events_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."completed_at" IS NULL THEN
      RAISE EXCEPTION 'incomplete outbox event cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."id", NEW."event_type", NEW."schema_version", NEW."aggregate_type", NEW."aggregate_id",
      NEW."aggregate_version", NEW."payload", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."event_type", OLD."schema_version", OLD."aggregate_type", OLD."aggregate_id",
      OLD."aggregate_version", OLD."payload", OLD."created_at") THEN
    RAISE EXCEPTION 'outbox event identity and payload are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
    RAISE EXCEPTION 'completed outbox event cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."completed_at" IS NULL AND NEW."completed_at" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "consumer_effects" e
    WHERE e."event_id" = NEW."id" AND e."status" NOT IN ('completed', 'skipped')
  ) THEN
    RAISE EXCEPTION 'outbox event has unfinished effects' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "outbox_events_guard"
  BEFORE UPDATE OR DELETE ON "outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "outbox_events_guard"();

-- Effects: required set is fixed once the event completes; identity immutable; completed/skipped
-- terminal; dead leaves only through replay (-> pending/retry), which is counted and audited by the
-- replay command (step 24). Effects are deleted only to prune a completed event.
CREATE FUNCTION "consumer_effects_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- FOR SHARE conflicts with the completion UPDATE's row lock, so the two cannot interleave.
    PERFORM 1 FROM "outbox_events" o WHERE o."id" = NEW."event_id" AND o."completed_at" IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'effects cannot be added to a completed or missing event' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" NOT IN ('completed', 'skipped') OR NOT EXISTS (
      SELECT 1 FROM "outbox_events" o WHERE o."id" = OLD."event_id" AND o."completed_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'consumer effects are deleted only when pruning a completed event' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."id", NEW."event_id", NEW."consumer", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."event_id", OLD."consumer", OLD."created_at") THEN
    RAISE EXCEPTION 'consumer effect identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('completed', 'skipped') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed consumer effect is terminal' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'dead' AND NEW."status" <> 'dead' THEN
    IF NEW."status" NOT IN ('pending', 'retry') THEN
      RAISE EXCEPTION 'dead effect may only be replayed to pending or retry' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW."replays" := OLD."replays" + 1;
  ELSIF NEW."replays" <> OLD."replays" THEN
    RAISE EXCEPTION 'replay count changes only on replay' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "consumer_effects_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "consumer_effects"
  FOR EACH ROW EXECUTE FUNCTION "consumer_effects_guard"();

-- Runtime role: no TRUNCATE on reliability tables and no effect deletes. Pruning (BI-08 retention)
-- runs as a dedicated maintenance role, deleting completed effects and then their completed event.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
    REVOKE TRUNCATE ON "outbox_events" FROM ih_app;
    REVOKE DELETE, TRUNCATE ON "consumer_effects" FROM ih_app;
  END IF;
END;
$$;
