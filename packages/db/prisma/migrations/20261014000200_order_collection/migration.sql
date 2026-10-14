-- Cash-on-delivery collection and its corrections (roadmap step 87, ADR 0055).
-- The order's own collection fields hold the original evidence and are written once (the
-- orders guard already refuses rewriting them). Every collection command, the first record and
-- each later Owner correction, is one immutable row here; the latest row is what is in effect.
CREATE TABLE order_collection_records (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('recorded','corrected')),
  command_id UUID NOT NULL UNIQUE,
  actor_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  order_version INTEGER NOT NULL CHECK (order_version > 1),
  amount_fils BIGINT NOT NULL CHECK (amount_fils BETWEEN 0 AND 1000000000000),
  collected_at TIMESTAMPTZ(6) NOT NULL,
  reference VARCHAR(100) CHECK (reference IS NULL
    OR (length(reference) >= 1 AND reference = btrim(reference))),
  -- A correction always says why; the first record does not need to.
  reason VARCHAR(500) CHECK (reason IS NULL OR (length(reason) >= 1 AND reason = btrim(reason))),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT order_collection_reason CHECK ((kind = 'corrected') = (reason IS NOT NULL)),
  CONSTRAINT order_collection_time CHECK (collected_at <= created_at)
);
-- An order's cash is recorded once; everything after that is a correction.
CREATE UNIQUE INDEX order_collection_records_once ON order_collection_records (order_id)
  WHERE kind = 'recorded';
CREATE INDEX order_collection_records_order ON order_collection_records (order_id, seq);
CREATE TRIGGER order_collection_records_immutable BEFORE UPDATE OR DELETE
  ON order_collection_records FOR EACH ROW EXECUTE FUNCTION order_cancellation_immutable();
-- Written with its command: the order must be collected, at the version the row names, and the
-- first record must be exactly what the order holds as its original evidence.
CREATE FUNCTION order_collection_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id
      AND o.status = 'delivered' AND o.cod_status = 'collected' AND o.version = NEW.order_version
      AND (NEW.kind = 'recorded' OR (EXISTS (SELECT 1 FROM order_collection_records r
            WHERE r.order_id = NEW.order_id AND r.kind = 'recorded' AND r.seq < NEW.seq)
          AND NEW.collected_at >= date_trunc('minute', o.delivered_at)))
      AND (NEW.kind = 'corrected' OR (o.collected_amount_fils = NEW.amount_fils
        AND o.collected_at = NEW.collected_at AND o.collected_by = NEW.actor_id
        AND o.collection_reference IS NOT DISTINCT FROM NEW.reference))) THEN
    RAISE EXCEPTION 'A collection record must match its order' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_collection_matches AFTER INSERT ON order_collection_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_collection_matches();
-- Reports read collected cash by collection date.
CREATE INDEX orders_collected_at ON orders (collected_at) WHERE collected_at IS NOT NULL;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, DELETE, TRUNCATE ON order_collection_records FROM ih_app;
 END IF;
END;
$$;
