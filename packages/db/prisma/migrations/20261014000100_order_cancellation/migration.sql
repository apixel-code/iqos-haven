-- Order cancellation and returns (roadmap step 86, ADR 0054).
-- Stock comes back through the ledger with two order reasons. Their command ID is fixed per
-- order, so with the existing unique (command_id, variant_id, effect) a cancellation can return
-- each variant once, however often or concurrently it is attempted.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movement_reason;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movement_order;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_reason CHECK (
  reason IN ('INITIAL_STOCK','RESTOCK','MANUAL','DAMAGE','SALE','ORDER_EDIT','ORDER_CANCEL',
    'ORDER_RETURN'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_order CHECK (
  (reason IN ('SALE','ORDER_EDIT','ORDER_CANCEL','ORDER_RETURN')) = (order_id IS NOT NULL)
  AND (reason <> 'SALE' OR (delta < 0 AND effect='sale'
    AND command_id='order:' || order_id::text))
  AND (reason <> 'ORDER_EDIT' OR effect='order_edit')
  -- Before handoff: everything the order still holds goes back.
  AND (reason <> 'ORDER_CANCEL' OR (delta > 0 AND effect='order_cancel'
    AND command_id='cancel:' || order_id::text))
  -- After a return: only what was received in resellable condition goes back.
  AND (reason <> 'ORDER_RETURN' OR (delta > 0 AND effect='order_return'
    AND command_id='return:' || order_id::text)));

-- One row per cancelled order: the permanent record of the command that cancelled it. A retry
-- with the same command ID is answered from here; another command ID cannot cancel again.
CREATE TABLE order_cancellations (
  order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  command_id UUID NOT NULL UNIQUE,
  actor_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- 'before_handoff': Pending, Confirmed or Processing. 'returned': Out for Delivery, after the
  -- goods came back and every line was classified.
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('before_handoff','returned')),
  from_status VARCHAR(20) NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  order_version INTEGER NOT NULL CHECK (order_version > 1),
  coupon_released BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT order_cancellation_kind CHECK (
    (kind = 'before_handoff') = (from_status IN ('pending','confirmed','processing'))
    AND (kind = 'returned') = (from_status = 'out_for_delivery'))
);
-- How each line of a returned order came back. Damaged units are recorded, never restocked.
CREATE TABLE order_return_items (
  order_id UUID NOT NULL REFERENCES order_cancellations(order_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  sku VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  resellable_quantity INTEGER NOT NULL CHECK (resellable_quantity >= 0),
  damaged_quantity INTEGER NOT NULL CHECK (damaged_quantity >= 0),
  PRIMARY KEY (order_id, variant_id),
  CONSTRAINT order_return_item_classified CHECK (resellable_quantity + damaged_quantity = quantity)
);
CREATE FUNCTION order_cancellation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A cancellation record is never changed or removed' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER order_cancellations_immutable BEFORE UPDATE OR DELETE ON order_cancellations
  FOR EACH ROW EXECUTE FUNCTION order_cancellation_immutable();
CREATE TRIGGER order_return_items_immutable BEFORE UPDATE OR DELETE ON order_return_items
  FOR EACH ROW EXECUTE FUNCTION order_cancellation_immutable();
-- The record is written with the cancellation itself: the order must be cancelled, at the
-- version the record names, by the time the transaction commits.
CREATE FUNCTION order_cancellation_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND status = 'cancelled'
      AND version = NEW.order_version) THEN
    RAISE EXCEPTION 'A cancellation record must match its cancelled order' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_cancellation_matches AFTER INSERT ON order_cancellations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_cancellation_matches();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, DELETE, TRUNCATE ON order_cancellations, order_return_items FROM ih_app;
 END IF;
END;
$$;
