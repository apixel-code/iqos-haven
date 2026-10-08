-- Reconciler (step 24) selects stale queued effects by queued_at and crashed runs by lease
-- expiry; the earlier (status, updated_at) index matched neither predicate.
CREATE INDEX "consumer_effects_queued_idx" ON "consumer_effects" ("queued_at", "id")
  WHERE "status" = 'queued';
CREATE INDEX "consumer_effects_running_idx" ON "consumer_effects" ("lease_expires_at", "id")
  WHERE "status" = 'running';
DROP INDEX "consumer_effects_active_idx";
