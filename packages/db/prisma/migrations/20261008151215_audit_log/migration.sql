-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(128) NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "command_id" VARCHAR(128),
    "reason" VARCHAR(500),
    "diff" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_occurred_at_idx" ON "audit_log"("entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit_log"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at" DESC);

-- Hand-written (reviewed): shape constraints mirror @ih/domain audit validation.
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_ck" CHECK (
    ("actor_type" = 'staff' AND "actor_id" IS NOT NULL)
    OR ("actor_type" = 'system' AND "actor_id" IS NULL)
  ),
  ADD CONSTRAINT "audit_log_action_ck" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "audit_log_entity_type_ck" CHECK ("entity_type" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "audit_log_entity_id_ck" CHECK (length("entity_id") > 0),
  ADD CONSTRAINT "audit_log_request_id_ck" CHECK (length("request_id") > 0),
  ADD CONSTRAINT "audit_log_command_id_ck" CHECK ("command_id" IS NULL OR length("command_id") > 0),
  ADD CONSTRAINT "audit_log_diff_ck" CHECK (
    jsonb_typeof("diff") = 'object' AND octet_length("diff"::text) <= 65536
  );

-- Append-only: rows are never edited or removed by any role through ordinary statements.
-- Retention pruning (BI-08) will need a separate, reviewed owner-only procedure.
CREATE FUNCTION "audit_log_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_log_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();

CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_reject_mutation"();

-- Defense in depth: the runtime role may only read and append.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM ih_app;
  END IF;
END;
$$;
