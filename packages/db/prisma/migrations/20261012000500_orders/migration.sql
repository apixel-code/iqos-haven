-- Orders (roadmap step 73, ADR 0042). An order keeps its own copy of everything it was placed
-- with: customer, address, area, lines, prices, coupon and totals. Later edits of customers,
-- products, coupons or delivery settings never reach it. Orders are never deleted.
CREATE FUNCTION order_transition_allowed(from_status TEXT, to_status TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  -- Never NULL: a CHECK accepts NULL, so an unknown or missing status must be a plain "no".
  SELECT coalesce((from_status, to_status) IN (
    ('pending','confirmed'), ('pending','cancelled'),
    ('confirmed','processing'), ('confirmed','cancelled'),
    ('processing','out_for_delivery'), ('processing','cancelled'),
    ('out_for_delivery','delivered'), ('out_for_delivery','cancelled')), false);
$$;

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  -- Sequential display number. It identifies an order to people; it authorizes nothing.
  -- Gaps are normal (a rolled-back attempt uses a number).
  order_number BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1001),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  source VARCHAR(16) NOT NULL,
  created_by UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Customer and address as given for this order.
  customer_name VARCHAR(100) NOT NULL,
  customer_phone_e164 VARCHAR(16) NOT NULL,
  area_id UUID NOT NULL REFERENCES delivery_areas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  area_code VARCHAR(64) NOT NULL,
  area_name VARCHAR(100) NOT NULL,
  area_emirate VARCHAR(16) NOT NULL,
  address_type VARCHAR(16) NOT NULL,
  address_building VARCHAR(150) NOT NULL,
  address_unit VARCHAR(50),
  address_street VARCHAR(150),
  address_makani VARCHAR(10),
  address_notes VARCHAR(500),
  -- Money in integer fils. No tax columns: the entered price is final (ADR 0036).
  merchandise_subtotal_fils BIGINT NOT NULL,
  discount_fils BIGINT NOT NULL DEFAULT 0,
  delivery_fee_fils BIGINT NOT NULL,
  total_fils BIGINT NOT NULL,
  coupon_code VARCHAR(32),
  coupon_percent_bps INTEGER,
  -- What the quote was built from.
  delivery_eta_text VARCHAR(500) NOT NULL,
  area_version INTEGER NOT NULL CHECK (area_version > 0),
  delivery_configuration_version INTEGER NOT NULL CHECK (delivery_configuration_version > 0),
  quote_fingerprint VARCHAR(64) NOT NULL,
  -- The second 18+ confirmation given at checkout.
  age_confirmed_at TIMESTAMPTZ(6) NOT NULL,
  age_policy_version VARCHAR(64) NOT NULL,
  -- Cash on delivery. Delivered never implies collected: collection is its own command.
  cod_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  collected_amount_fils BIGINT,
  collected_at TIMESTAMPTZ(6),
  collected_by UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  collection_reference VARCHAR(100),
  cancel_reason VARCHAR(500),
  dispatched_at TIMESTAMPTZ(6),
  delivered_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  returned_at TIMESTAMPTZ(6),
  -- The attempt that created the order: a hash of its idempotency key, never the key.
  creation_scope VARCHAR(64) NOT NULL,
  creation_key_hash BYTEA NOT NULL,
  creation_payload_hash BYTEA NOT NULL,
  -- Verifier of the confirmation capability; the capability itself is never stored.
  confirmation_hash BYTEA,
  confirmation_expires_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT orders_order_number_key UNIQUE (order_number),
  CONSTRAINT orders_creation_key UNIQUE (creation_scope, creation_key_hash),
  CONSTRAINT order_status CHECK (status IN
    ('pending','confirmed','processing','out_for_delivery','delivered','cancelled')),
  CONSTRAINT order_source CHECK (source IN ('storefront','manual')),
  CONSTRAINT order_manual_actor CHECK ((source = 'manual') = (created_by IS NOT NULL)),
  CONSTRAINT order_customer_name CHECK (
    length(customer_name) BETWEEN 1 AND 100 AND customer_name = btrim(customer_name)),
  CONSTRAINT order_customer_phone CHECK (customer_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT order_area_emirate CHECK (area_emirate IN
    ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah')),
  CONSTRAINT order_address_type CHECK (address_type IN ('apartment','villa','office')),
  CONSTRAINT order_address_building CHECK (
    length(address_building) >= 1 AND address_building = btrim(address_building)),
  CONSTRAINT order_address_unit CHECK (address_unit IS NULL
    OR (length(address_unit) >= 1 AND address_unit = btrim(address_unit))),
  CONSTRAINT order_address_street CHECK (address_street IS NULL
    OR (length(address_street) >= 1 AND address_street = btrim(address_street))),
  CONSTRAINT order_address_makani CHECK (address_makani IS NULL OR address_makani ~ '^[0-9]{10}$'),
  CONSTRAINT order_address_notes CHECK (address_notes IS NULL
    OR (length(address_notes) >= 1 AND address_notes = btrim(address_notes))),
  CONSTRAINT order_subtotal CHECK (merchandise_subtotal_fils BETWEEN 1 AND 1000000000000),
  CONSTRAINT order_discount CHECK (discount_fils BETWEEN 0 AND merchandise_subtotal_fils),
  CONSTRAINT order_delivery_fee CHECK (delivery_fee_fils BETWEEN 0 AND 1000000000),
  -- The total is never a free number: it is exactly what its parts make.
  CONSTRAINT order_total CHECK (
    total_fils = merchandise_subtotal_fils - discount_fils + delivery_fee_fils),
  CONSTRAINT order_coupon_pair CHECK ((coupon_code IS NULL) = (coupon_percent_bps IS NULL)),
  CONSTRAINT order_coupon_code CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT order_coupon_percent CHECK (coupon_percent_bps IS NULL
    OR coupon_percent_bps BETWEEN 1 AND 10000),
  CONSTRAINT order_discount_needs_coupon CHECK (coupon_code IS NOT NULL OR discount_fils = 0),
  CONSTRAINT order_eta CHECK (length(btrim(delivery_eta_text)) BETWEEN 1 AND 500),
  CONSTRAINT order_quote_fingerprint CHECK (quote_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT order_age_policy CHECK (length(btrim(age_policy_version)) BETWEEN 1 AND 64),
  CONSTRAINT order_cod_status CHECK (cod_status IN ('pending','collected','not_collected')),
  CONSTRAINT order_cod_collected CHECK ((cod_status = 'collected') = (
    collected_amount_fils IS NOT NULL AND collected_at IS NOT NULL AND collected_by IS NOT NULL)),
  CONSTRAINT order_cod_fields CHECK (cod_status = 'collected' OR (
    collected_amount_fils IS NULL AND collected_at IS NULL AND collected_by IS NULL
    AND collection_reference IS NULL)),
  CONSTRAINT order_cod_amount CHECK (collected_amount_fils IS NULL
    OR collected_amount_fils BETWEEN 0 AND 1000000000000),
  -- Cash is recorded for a delivered order only; a cancelled order is never "pending cash".
  CONSTRAINT order_cod_needs_delivery CHECK (cod_status <> 'collected' OR status = 'delivered'),
  CONSTRAINT order_cod_cancelled CHECK ((status = 'cancelled') = (cod_status = 'not_collected')),
  CONSTRAINT order_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT order_cancel_reason CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)
    AND (cancel_reason IS NULL
      OR (length(cancel_reason) >= 1 AND cancel_reason = btrim(cancel_reason)))),
  CONSTRAINT order_delivered CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT order_dispatched CHECK (
    (status NOT IN ('out_for_delivery','delivered') OR dispatched_at IS NOT NULL)
    AND (dispatched_at IS NULL OR status IN ('out_for_delivery','delivered','cancelled'))),
  CONSTRAINT order_returned CHECK (returned_at IS NULL
    OR (status = 'cancelled' AND dispatched_at IS NOT NULL)),
  CONSTRAINT order_creation_scope CHECK (creation_scope ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT order_creation_hashes CHECK (
    octet_length(creation_key_hash) = 32 AND octet_length(creation_payload_hash) = 32),
  CONSTRAINT order_confirmation CHECK ((confirmation_hash IS NULL) = (confirmation_expires_at IS NULL)
    AND (confirmation_hash IS NULL OR octet_length(confirmation_hash) = 32))
);
CREATE UNIQUE INDEX orders_confirmation_hash ON orders (confirmation_hash)
  WHERE confirmation_hash IS NOT NULL;
CREATE INDEX orders_customer ON orders (customer_id, created_at DESC, id DESC);
CREATE INDEX orders_status ON orders (status, created_at DESC, id DESC);

CREATE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Orders are never deleted' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The store creates Pending; only a staff-entered order may start Confirmed.
    IF NEW.status <> 'pending' AND NOT (NEW.source = 'manual' AND NEW.status = 'confirmed') THEN
      RAISE EXCEPTION 'An order starts pending' USING ERRCODE='23514';
    END IF;
    IF NEW.version <> 1 OR NEW.cod_status <> 'pending' THEN
      RAISE EXCEPTION 'An order starts at version 1 with cash pending' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_number IS DISTINCT FROM OLD.order_number
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.creation_scope IS DISTINCT FROM OLD.creation_scope
     OR NEW.creation_key_hash IS DISTINCT FROM OLD.creation_key_hash
     OR NEW.creation_payload_hash IS DISTINCT FROM OLD.creation_payload_hash
     OR NEW.age_confirmed_at IS DISTINCT FROM OLD.age_confirmed_at
     OR NEW.age_policy_version IS DISTINCT FROM OLD.age_policy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE='23514';
  END IF;
  -- Every change is one version step, so "the version I saw" always detects another writer.
  IF NEW IS DISTINCT FROM OLD AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'An order change advances its version by one' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT order_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'Order cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  -- What was ordered, for whom, where and for how much may change only while the order is
  -- still Pending or Confirmed (a controlled edit). After that it is fixed for good.
  -- The update that moves it on cannot change them either.
  IF (OLD.status NOT IN ('pending','confirmed') OR NEW.status NOT IN ('pending','confirmed')) AND (
       (to_jsonb(NEW) - ARRAY['status','version','updated_at','cod_status','collected_amount_fils',
          'collected_at','collected_by','collection_reference','cancel_reason','dispatched_at',
          'delivered_at','cancelled_at','returned_at','confirmation_hash','confirmation_expires_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','version','updated_at','cod_status','collected_amount_fils',
          'collected_at','collected_by','collection_reference','cancel_reason','dispatched_at',
          'delivered_at','cancelled_at','returned_at','confirmation_hash','confirmation_expires_at'])) THEN
    RAISE EXCEPTION 'Order contents are fixed once processing starts' USING ERRCODE='23514';
  END IF;
  -- What happened stays recorded: a dispatch, delivery, cancellation, return or cash record is
  -- written once. A later correction is a new record elsewhere, never an overwrite.
  IF (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
     OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
     OR (OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at)
     OR (OLD.cancel_reason IS NOT NULL AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason)
     OR (OLD.cod_status <> 'pending' AND (
          NEW.cod_status IS DISTINCT FROM OLD.cod_status
          OR NEW.collected_amount_fils IS DISTINCT FROM OLD.collected_amount_fils
          OR NEW.collected_at IS DISTINCT FROM OLD.collected_at
          OR NEW.collected_by IS DISTINCT FROM OLD.collected_by
          OR NEW.collection_reference IS DISTINCT FROM OLD.collection_reference)) THEN
    RAISE EXCEPTION 'Recorded order events are not rewritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_guard BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();

-- One row per variant in an order, with what that variant was when it was sold.
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  product_name VARCHAR(150) NOT NULL,
  product_slug VARCHAR(150) NOT NULL,
  brand_name VARCHAR(150) NOT NULL,
  category_name VARCHAR(150) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  -- Option values as sold, e.g. {"flavour": "grape"}.
  attributes JSONB NOT NULL DEFAULT '{}',
  product_version INTEGER NOT NULL CHECK (product_version > 0),
  variant_version INTEGER NOT NULL CHECK (variant_version > 0),
  unit_price_fils BIGINT NOT NULL,
  quantity INTEGER NOT NULL,
  subtotal_fils BIGINT NOT NULL,
  discount_fils BIGINT NOT NULL DEFAULT 0,
  total_fils BIGINT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  -- Repeated lines are merged before an order is written.
  CONSTRAINT order_items_variant_key UNIQUE (order_id, variant_id),
  CONSTRAINT order_item_names CHECK (length(btrim(product_name)) >= 1 AND length(btrim(sku)) >= 1
    AND length(btrim(product_slug)) >= 1 AND length(btrim(brand_name)) >= 1
    AND length(btrim(category_name)) >= 1),
  CONSTRAINT order_item_attributes CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT order_item_unit_price CHECK (unit_price_fils BETWEEN 1 AND 1000000000),
  CONSTRAINT order_item_quantity CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT order_item_subtotal CHECK (subtotal_fils = unit_price_fils * quantity),
  CONSTRAINT order_item_discount CHECK (discount_fils BETWEEN 0 AND subtotal_fils),
  CONSTRAINT order_item_total CHECK (total_fils = subtotal_fils - discount_fils)
);
CREATE INDEX order_items_variant ON order_items (variant_id);
CREATE FUNCTION order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO parent FROM orders WHERE id = OLD.order_id;
  ELSE
    SELECT status INTO parent FROM orders WHERE id = NEW.order_id;
  END IF;
  IF parent NOT IN ('pending','confirmed') THEN
    RAISE EXCEPTION 'Order lines are fixed once processing starts' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
      OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    RAISE EXCEPTION 'An order line keeps its order and variant' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_items_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_guard();

-- Every status an order has had, in order, and why. Append-only.
CREATE TABLE order_status_history (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  reason VARCHAR(500),
  actor_kind VARCHAR(16) NOT NULL,
  actor_id UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Names the command that caused the change; a repeated command cannot add a second row.
  command_id VARCHAR(128) NOT NULL,
  order_version INTEGER NOT NULL CHECK (order_version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT order_status_history_seq_key UNIQUE (seq),
  CONSTRAINT order_status_history_command UNIQUE (order_id, command_id),
  CONSTRAINT order_history_to CHECK (to_status IN
    ('pending','confirmed','processing','out_for_delivery','delivered','cancelled')),
  CONSTRAINT order_history_step CHECK (
    (from_status IS NULL AND to_status IN ('pending','confirmed'))
    OR order_transition_allowed(from_status, to_status)),
  CONSTRAINT order_history_actor CHECK (actor_kind IN ('customer','staff','system')
    AND (actor_kind = 'staff') = (actor_id IS NOT NULL)),
  CONSTRAINT order_history_command_id CHECK (length(btrim(command_id)) >= 1),
  CONSTRAINT order_history_reason CHECK (reason IS NULL
    OR (length(reason) >= 1 AND reason = btrim(reason))),
  -- A cancellation always says why.
  CONSTRAINT order_history_cancel_reason CHECK (to_status <> 'cancelled' OR reason IS NOT NULL)
);
CREATE INDEX order_status_history_order ON order_status_history (order_id, seq);
-- A status is left at most once (the state machine has no way back), and an order has one
-- first row. This holds even if two writers race without the order lock.
CREATE UNIQUE INDEX order_status_history_one_exit ON order_status_history (order_id, from_status)
  NULLS NOT DISTINCT;
CREATE FUNCTION order_status_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous TEXT;
  origin TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Order history is append-only' USING ERRCODE='42501';
  END IF;
  -- The first row is the creation: pending, or confirmed for a staff-entered order only.
  IF NEW.from_status IS NULL THEN
    SELECT source INTO origin FROM orders WHERE id = NEW.order_id;
    IF NEW.order_version <> 1
       OR NOT (NEW.to_status = 'pending' OR (origin = 'manual' AND NEW.to_status = 'confirmed')) THEN
      RAISE EXCEPTION 'Order history starts at creation' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT to_status INTO previous FROM order_status_history
    WHERE order_id = NEW.order_id ORDER BY seq DESC LIMIT 1;
  IF previous IS DISTINCT FROM NEW.from_status THEN
    RAISE EXCEPTION 'Order history must continue from the last status' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_status_history_guard BEFORE INSERT OR UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION order_status_history_guard();

-- Checked when the transaction commits, so an order, its lines and its history can be written
-- in any sequence inside one transaction but can never be committed disagreeing:
-- an order has lines, its totals are the sum of its lines, and its status is the last history row.
CREATE FUNCTION order_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  o RECORD;
  lines RECORD;
  last_status TEXT;
BEGIN
  -- Separate statements: a record field that does not exist for this table must not be parsed.
  IF TG_TABLE_NAME = 'orders' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.order_id;
  ELSE
    target := NEW.order_id;
  END IF;
  SELECT status, merchandise_subtotal_fils, discount_fils INTO o FROM orders WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) AS n, coalesce(sum(subtotal_fils), 0) AS subtotal,
    coalesce(sum(discount_fils), 0) AS discount INTO lines FROM order_items WHERE order_id = target;
  IF lines.n = 0 THEN
    RAISE EXCEPTION 'An order needs at least one line' USING ERRCODE='23514';
  END IF;
  IF lines.subtotal <> o.merchandise_subtotal_fils OR lines.discount <> o.discount_fils THEN
    RAISE EXCEPTION 'Order totals must equal the sum of its lines' USING ERRCODE='23514';
  END IF;
  SELECT to_status INTO last_status FROM order_status_history
    WHERE order_id = target ORDER BY seq DESC LIMIT 1;
  IF last_status IS DISTINCT FROM o.status THEN
    RAISE EXCEPTION 'Order status must match its history' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_consistent_order AFTER INSERT OR UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_consistent();
CREATE CONSTRAINT TRIGGER order_consistent_items AFTER INSERT OR UPDATE OR DELETE ON order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_consistent();
CREATE CONSTRAINT TRIGGER order_consistent_history AFTER INSERT ON order_status_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_consistent();

-- The coupon use recorded in step 68 now points at a real order.
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_order_fk
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON orders, order_items, order_status_history FROM ih_app;
  REVOKE UPDATE ON order_status_history FROM ih_app;
 END IF;
END;
$$;
