-- Stock sold by an order (roadmap step 76). A sale is one ledger movement per order line,
-- written in the order's own transaction and pointing at the order. Releases and returns
-- arrive with cancellation (step 86).
ALTER TABLE stock_movements
  ADD COLUMN order_id UUID REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
DO $$
DECLARE
  old_check text;
BEGIN
  SELECT conname INTO STRICT old_check FROM pg_constraint
   WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%INITIAL_STOCK%'
     AND pg_get_constraintdef(oid) LIKE '%MANUAL%'
     AND pg_get_constraintdef(oid) LIKE '%RESTOCK%'
     AND pg_get_constraintdef(oid) LIKE '%ANY%';
  EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', old_check);
END;
$$;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_reason CHECK (
  reason IN ('INITIAL_STOCK','RESTOCK','MANUAL','DAMAGE','SALE'));
-- A sale removes stock, belongs to an order and uses the 'sale' effect; nothing else may point
-- at an order. With the existing unique (command_id, variant_id, effect) and the command ID
-- 'order:<id>', an order can sell a variant once.
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_sale CHECK (
  (reason = 'SALE') = (order_id IS NOT NULL)
  AND (reason <> 'SALE' OR (delta < 0 AND effect = 'sale' AND command_id = 'order:' || order_id::text)));
CREATE INDEX stock_movements_order ON stock_movements (order_id) WHERE order_id IS NOT NULL;
