-- Free delivery from a threshold (ADR 0113, client 2026-11-12): the delivery setting may hold
-- `freeThresholdFils`, a positive integer amount of fils (or null = free delivery off). Orders
-- whose merchandise after discount reaches it pay no delivery fee.
--
-- Expand only: the constraint is relaxed, never tightened. The previous release reads the setting
-- only while it is null, and the Owner sets a threshold after this release is live.
ALTER TABLE settings DROP CONSTRAINT settings_delivery_value;
ALTER TABLE settings ADD CONSTRAINT settings_delivery_value CHECK (
 key <> 'delivery' OR value='null'::jsonb OR (
  jsonb_typeof(value)='object' AND value ?& ARRAY['flatFeeFils','etaText','freeThresholdFils']
  AND value - ARRAY['flatFeeFils','etaText','freeThresholdFils'] = '{}'::jsonb
  AND jsonb_typeof(value->'flatFeeFils')='number'
  AND (value->>'flatFeeFils')::numeric BETWEEN 0 AND 1000000000
  AND (value->>'flatFeeFils')::numeric=trunc((value->>'flatFeeFils')::numeric)
  AND jsonb_typeof(value->'etaText')='string' AND length(btrim(value->>'etaText')) BETWEEN 1 AND 500
  AND (
   value->'freeThresholdFils'='null'::jsonb OR (
    jsonb_typeof(value->'freeThresholdFils')='number'
    AND (value->>'freeThresholdFils')::numeric BETWEEN 1 AND 1000000000
    AND (value->>'freeThresholdFils')::numeric=trunc((value->>'freeThresholdFils')::numeric)
   )
  )
 )
);
