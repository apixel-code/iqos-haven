-- One order may use different coupons over its editable lifetime, but only one is active.
ALTER TABLE coupon_redemptions DROP CONSTRAINT coupon_redemptions_order_key;
CREATE UNIQUE INDEX coupon_redemptions_active_order ON coupon_redemptions(order_id)
  WHERE released_at IS NULL;

-- Pending/Confirmed edits can remove lines. The order trigger still refuses this later.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ih_app') THEN
  GRANT DELETE ON order_items TO ih_app;
 END IF;
END $$;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movement_reason;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movement_sale;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_reason CHECK (
  reason IN ('INITIAL_STOCK','RESTOCK','MANUAL','DAMAGE','SALE','ORDER_EDIT'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_order CHECK (
  (reason IN ('SALE','ORDER_EDIT')) = (order_id IS NOT NULL)
  AND (reason <> 'SALE' OR (delta < 0 AND effect='sale'
    AND command_id='order:' || order_id::text))
  AND (reason <> 'ORDER_EDIT' OR effect='order_edit'));

-- Successful edits are the permanent command ledger and the staff-facing diff timeline.
CREATE TABLE order_edit_history (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  actor_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  command_id UUID NOT NULL UNIQUE,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  order_version INTEGER NOT NULL CHECK (order_version>1),
  diff JSONB NOT NULL CHECK (jsonb_typeof(diff)='object' AND diff<>'{}'::jsonb),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX order_edit_history_order ON order_edit_history(order_id,seq);
CREATE FUNCTION order_edit_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Order edit history is append-only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER order_edit_history_append_only BEFORE UPDATE OR DELETE ON order_edit_history
  FOR EACH ROW EXECUTE FUNCTION order_edit_history_append_only();
CREATE TRIGGER order_edit_history_no_truncate BEFORE TRUNCATE ON order_edit_history
  FOR EACH STATEMENT EXECUTE FUNCTION order_edit_history_append_only();
CREATE FUNCTION order_edit_history_matches_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM orders WHERE id=NEW.order_id AND version=NEW.order_version) THEN
  RAISE EXCEPTION 'Order edit history version must match the order'
    USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_edit_history_matches_order
  AFTER INSERT ON order_edit_history DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_edit_history_matches_order();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ih_app') THEN
  REVOKE UPDATE,DELETE,TRUNCATE ON order_edit_history FROM ih_app;
 END IF;
END $$;
