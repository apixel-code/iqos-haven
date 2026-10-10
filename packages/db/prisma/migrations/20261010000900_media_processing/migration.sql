-- Media processing and quarantine cleanup (roadmap step 49, ADR 0019). Originals stay private and
-- are deleted from quarantine after processing (short retention) or when the upload expired or was
-- rejected; the row is kept as history and records when its quarantine object was purged.
ALTER TABLE media_assets ADD COLUMN quarantine_purged_at TIMESTAMPTZ(6);
CREATE INDEX media_assets_purge ON media_assets(updated_at)
 WHERE quarantine_purged_at IS NULL AND state IN ('expired','rejected','ready');

-- Backfill (ADR 0019, architecture §8): step 48 published `media.uploaded` while it had no
-- required consumer. Adding `media_processor` must not redefine those completed events, so every
-- asset still `uploaded` without a processor effect gets a fresh event + effect instead.
-- Idempotent; re-runnable by operations if needed.
CREATE FUNCTION media_backfill_processing() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE created integer;
BEGIN
 WITH waiting AS (
  SELECT m.id, m.version FROM media_assets m
  WHERE m.state='uploaded' AND NOT EXISTS (
   SELECT 1 FROM outbox_events e JOIN consumer_effects c ON c.event_id=e.id
   WHERE e.event_type='media.uploaded' AND e.aggregate_id=m.id::text
     AND c.consumer='media_processor')
 ), events AS (
  INSERT INTO outbox_events (event_type, schema_version, aggregate_type, aggregate_id,
    aggregate_version, payload)
  SELECT 'media.uploaded', 1, 'media_asset', w.id::text, w.version,
    jsonb_build_object('mediaAssetId', w.id::text)
  FROM waiting w RETURNING id
 )
 INSERT INTO consumer_effects (event_id, consumer) SELECT id, 'media_processor' FROM events;
 GET DIAGNOSTICS created = ROW_COUNT;
 RETURN created;
END;
$$;
SELECT media_backfill_processing();

