-- BI-02 answered 2026-10-12: the price the Owner enters is the final price the customer pays.
-- No separate VAT/excise calculation, so publishing no longer needs a tax treatment reference.
-- The tax_treatment_* columns stay (unused, nullable) so the previous app version keeps working.
DO $$
DECLARE
  old_check text;
BEGIN
  SELECT conname INTO STRICT old_check FROM pg_constraint
   WHERE conrelid = 'products'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%published%'
     AND pg_get_constraintdef(oid) LIKE '%tax_treatment_ref IS NOT NULL%';
  EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', old_check);
END;
$$;
ALTER TABLE products ADD CONSTRAINT products_publishable CHECK (
  status<>'published' OR (deleted_at IS NULL AND base_price_fils>0
    AND (type<>'disposable' OR puff_count IS NOT NULL))
);
