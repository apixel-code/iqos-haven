-- Expand settings without changing the step-38 groups or seeding business values.
ALTER TABLE settings DROP CONSTRAINT settings_key;
ALTER TABLE settings ADD CONSTRAINT settings_key CHECK (key IN ('store','contact','notifications','whatsapp','delivery'));
CREATE TABLE delivery_areas (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  emirate VARCHAR(16) NOT NULL DEFAULT 'dubai',
  active BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT delivery_area_code CHECK (code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT delivery_area_name CHECK (length(btrim(name)) BETWEEN 1 AND 100 AND name=btrim(name)),
  CONSTRAINT delivery_area_emirate CHECK (emirate='dubai')
);
CREATE UNIQUE INDEX delivery_area_name_unique ON delivery_areas (lower(name));
CREATE FUNCTION delivery_area_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.emirate IS DISTINCT FROM OLD.emirate THEN
    RAISE EXCEPTION 'Delivery area identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_area_immutable_identity BEFORE UPDATE ON delivery_areas FOR EACH ROW EXECUTE FUNCTION delivery_area_immutable_identity();
-- Only a single configured Dubai fee/ETA. Free delivery stays disabled in this launch slice.
ALTER TABLE settings ADD CONSTRAINT settings_delivery_value CHECK (
 key <> 'delivery' OR value='null'::jsonb OR (
  jsonb_typeof(value)='object' AND value ?& ARRAY['flatFeeFils','etaText','freeThresholdFils']
  AND value - ARRAY['flatFeeFils','etaText','freeThresholdFils'] = '{}'::jsonb
  AND jsonb_typeof(value->'flatFeeFils')='number'
  AND (value->>'flatFeeFils')::numeric BETWEEN 0 AND 1000000000
  AND (value->>'flatFeeFils')::numeric=trunc((value->>'flatFeeFils')::numeric)
  AND jsonb_typeof(value->'etaText')='string' AND length(btrim(value->>'etaText')) BETWEEN 1 AND 500
  AND value->'freeThresholdFils'='null'::jsonb
 )
);
-- No areas, fee or ETA seeds: BI-03 needs client approval.
