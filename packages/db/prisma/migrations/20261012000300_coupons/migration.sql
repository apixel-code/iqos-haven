-- Percentage coupons (step 68). One kind only: a percentage of merchandise, optional minimum
-- spend, start, expiry and usage limit. No fixed-value or scoped coupons, no seeds.
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  code VARCHAR(32) NOT NULL,
  percent_bps INTEGER NOT NULL,
  min_subtotal_fils BIGINT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ(6),
  expires_at TIMESTAMPTZ(6),
  active BOOLEAN NOT NULL DEFAULT false,
  usage_limit INTEGER,
  active_redemptions INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT coupons_code_key UNIQUE (code),
  -- Stored normalized: upper case, so "save10" and "SAVE10" are one code.
  CONSTRAINT coupon_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT coupon_percent CHECK (percent_bps BETWEEN 1 AND 10000),
  CONSTRAINT coupon_min_subtotal CHECK (min_subtotal_fils BETWEEN 0 AND 1000000000),
  CONSTRAINT coupon_window CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT coupon_usage_limit CHECK (usage_limit IS NULL OR usage_limit > 0),
  CONSTRAINT coupon_redemptions_count CHECK (active_redemptions >= 0),
  -- The last line of defence for "the limit is never exceeded", whatever the caller does.
  CONSTRAINT coupon_within_limit CHECK (usage_limit IS NULL OR active_redemptions <= usage_limit)
);
CREATE FUNCTION coupon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.active_redemptions<>0 THEN
      RAISE EXCEPTION 'Coupon use count starts at zero' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'Coupon identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.active_redemptions IS DISTINCT FROM OLD.active_redemptions AND pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'Coupon use count changes only through coupon_redemptions' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coupon_guard BEFORE INSERT OR UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION coupon_guard();

-- One row per order that used a coupon, with what was applied at that moment. The foreign key
-- from order_id to orders arrives with the orders migration (step 73).
CREATE TABLE coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  order_id UUID NOT NULL,
  code VARCHAR(32) NOT NULL,
  percent_bps INTEGER NOT NULL CHECK (percent_bps BETWEEN 1 AND 10000),
  merchandise_subtotal_fils BIGINT NOT NULL CHECK (merchandise_subtotal_fils BETWEEN 1 AND 1000000000000),
  discount_fils BIGINT NOT NULL,
  redeemed_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  released_at TIMESTAMPTZ(6),
  -- No stacking: an order has at most one redemption, ever.
  CONSTRAINT coupon_redemptions_order_key UNIQUE (order_id),
  CONSTRAINT coupon_redemption_discount CHECK (discount_fils BETWEEN 0 AND merchandise_subtotal_fils),
  CONSTRAINT coupon_redemption_release CHECK (released_at IS NULL OR released_at >= redeemed_at)
);
CREATE INDEX coupon_redemptions_coupon ON coupon_redemptions (coupon_id, redeemed_at DESC, id DESC);
-- SECURITY DEFINER: the runtime role has no right to write the use count itself (below), so
-- only this function, fired by a redemption row, can change it.
CREATE FUNCTION coupon_redemption_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'A redemption starts unreleased' USING ERRCODE='23514';
    END IF;
    UPDATE coupons SET active_redemptions=active_redemptions+1 WHERE id=NEW.coupon_id;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
     OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'A redemption only changes by being released once' USING ERRCODE='23514';
  END IF;
  UPDATE coupons SET active_redemptions=active_redemptions-1 WHERE id=NEW.coupon_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coupon_redemption_insert AFTER INSERT ON coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION coupon_redemption_apply();
CREATE TRIGGER coupon_redemption_update BEFORE UPDATE ON coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION coupon_redemption_apply();

-- Pin the lookup path to this schema (then pg_temp last) so callers cannot shadow tables.
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION coupon_redemption_apply() SET search_path = %I, pg_temp',
   current_schema());
 REVOKE ALL ON FUNCTION coupon_redemption_apply() FROM PUBLIC;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, DELETE, TRUNCATE ON coupons, coupon_redemptions FROM ih_app;
  -- Editable terms only: never the identity or the use count.
  GRANT UPDATE (percent_bps, min_subtotal_fils, starts_at, expires_at, active, usage_limit,
    version, updated_by, updated_at) ON coupons TO ih_app;
  -- A redemption changes in one way: it is released.
  GRANT UPDATE (released_at) ON coupon_redemptions TO ih_app;
 END IF;
END;
$$;
