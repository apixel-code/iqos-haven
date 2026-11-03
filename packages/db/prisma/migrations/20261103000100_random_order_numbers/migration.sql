-- Random order numbers (ADR 0104, Marina 2026-11-03). A shopper tracks an order by its number
-- alone, so a new number must not be guessable from another one: each new order gets a random
-- 12-digit number (100000000000 to 999999999999) instead of the next one in a sequence. Orders
-- placed before this keep their numbers; the storefront never tracks those (`@ih/domain`).
--
-- Expand only: the previous release never writes order_number, so it runs on this schema. The
-- number still cannot be chosen: an INSERT that sets it, or an UPDATE that changes it, is refused
-- with the identity column's error (428C9). The trigger's name sorts
-- before orders_guard, so it runs first and answers exactly as the identity column did.
ALTER TABLE orders ALTER COLUMN order_number DROP IDENTITY;

CREATE FUNCTION orders_assign_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_number IS DISTINCT FROM OLD.order_number THEN
      RAISE EXCEPTION 'The order number is assigned by the database' USING ERRCODE='428C9';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_number IS NOT NULL THEN
    RAISE EXCEPTION 'The order number is assigned by the database' USING ERRCODE='428C9';
  END IF;
  LOOP
    -- 48 random bits of a version-4 UUID (pg_strong_random), folded into the 12-digit range.
    candidate := 100000000000 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
      ::bit(48)::bigint % 900000000000);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE order_number = candidate);
  END LOOP;
  NEW.order_number := candidate;
  RETURN NEW;
END;
$$;
-- Pin the lookup path to this schema (then pg_temp last) so callers cannot shadow tables.
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION orders_assign_number() SET search_path = %I, pg_temp', current_schema());
 REVOKE ALL ON FUNCTION orders_assign_number() FROM PUBLIC;
END;
$$;
CREATE TRIGGER orders_assign_number BEFORE INSERT OR UPDATE OF order_number ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_assign_number();
