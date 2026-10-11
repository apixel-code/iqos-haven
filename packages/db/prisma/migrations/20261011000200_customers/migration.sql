-- Guest customers: a phone-keyed record for order history, never an account. No credential,
-- email or session column exists here and none may be added without a scope decision.
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  phone_e164 VARCHAR(16) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  first_order_at TIMESTAMPTZ(6),
  no_show BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customers_phone_e164_key UNIQUE (phone_e164),
  CONSTRAINT customer_phone_e164 CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT customer_display_name CHECK (
    length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)
  )
);
-- The normalized phone is the identity: a different phone is a different customer.
CREATE FUNCTION customer_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'Customer identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.first_order_at IS NOT NULL AND NEW.first_order_at IS DISTINCT FROM OLD.first_order_at THEN
    RAISE EXCEPTION 'Customer first order time is set once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_immutable_identity BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customer_immutable_identity();

-- Saved delivery addresses. Orders copy what they need into their own snapshot columns
-- (step 73); these rows are never the source for a past order.
CREATE TABLE customer_addresses (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  area_id UUID NOT NULL REFERENCES delivery_areas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  type VARCHAR(16) NOT NULL,
  building VARCHAR(150) NOT NULL,
  unit VARCHAR(50),
  street VARCHAR(150),
  makani VARCHAR(10),
  notes VARCHAR(500),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_address_type CHECK (type IN ('apartment','villa','office')),
  CONSTRAINT customer_address_building CHECK (length(building) >= 1 AND building = btrim(building)),
  CONSTRAINT customer_address_unit CHECK (unit IS NULL OR (length(unit) >= 1 AND unit = btrim(unit))),
  CONSTRAINT customer_address_street CHECK (street IS NULL OR (length(street) >= 1 AND street = btrim(street))),
  CONSTRAINT customer_address_makani CHECK (makani IS NULL OR makani ~ '^[0-9]{10}$'),
  CONSTRAINT customer_address_notes CHECK (notes IS NULL OR (length(notes) >= 1 AND notes = btrim(notes)))
);
CREATE INDEX customer_addresses_customer ON customer_addresses (customer_id, created_at DESC, id DESC);
-- An address row never changes: a corrected address is a new row, so an ID always means
-- the same place.
CREATE FUNCTION customer_address_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Customer addresses are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER customer_address_immutable BEFORE UPDATE ON customer_addresses
  FOR EACH ROW EXECUTE FUNCTION customer_address_immutable();

-- Runtime never deletes customer data; retention/anonymization is a later, reviewed path.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON customers, customer_addresses FROM ih_app;
  REVOKE UPDATE ON customer_addresses FROM ih_app;
 END IF;
END;
$$;
