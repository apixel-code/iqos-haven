-- Product purge vs derived rows (found on production 2026-11-10): a trashed product without
-- stock or order history could not be purged once it had saved-list statistics
-- (`wishlist_daily`) or a low-stock alert quiet window (`low_stock_alerts`). Their RESTRICT
-- foreign keys stopped the delete with a raw error instead of a clear answer.
--
-- These rows are derived, not history: the wishlist rollup already skips removed products
-- (daily-rollups.ts) and an alert window means nothing without the variant, so the purge removes
-- them. Sales figures (`product_sales_daily`) and order lines are history: the purge refuses with
-- the in-use code (IH004) before touching anything, as it does for stock movements.
--
-- Expand only: same signature; owner and grants are kept. CREATE OR REPLACE resets the function's
-- SET clauses, so the pinned search_path is set again below.
CREATE OR REPLACE FUNCTION catalogue_purge_product(target UUID)
RETURNS TABLE (storage_bucket TEXT, storage_key TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 PERFORM 1 FROM products WHERE id=target FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product' USING ERRCODE='P0002'; END IF;
 IF NOT EXISTS (SELECT 1 FROM products WHERE id=target AND deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Only trashed products can be purged' USING ERRCODE='IH003';
 END IF;
 IF EXISTS (SELECT 1 FROM stock_movements m JOIN variants v ON v.id=m.variant_id
            WHERE v.product_id=target) THEN
  RAISE EXCEPTION 'Product has stock history' USING ERRCODE='IH004';
 END IF;
 IF EXISTS (SELECT 1 FROM order_items WHERE product_id=target)
    OR EXISTS (SELECT 1 FROM product_sales_daily WHERE product_id=target) THEN
  RAISE EXCEPTION 'Product has order history' USING ERRCODE='IH004';
 END IF;
 -- Storage objects to remove after commit: derivatives and any unpurged quarantine originals.
 RETURN QUERY
  SELECT 'media'::text, d.value FROM media_assets a, jsonb_each_text(a.derivative_keys) d
  WHERE a.product_id=target
  UNION ALL
  SELECT 'quarantine'::text, a.quarantine_key FROM media_assets a
  WHERE a.product_id=target AND a.quarantine_purged_at IS NULL;
 DELETE FROM wishlist_daily WHERE product_id=target;
 DELETE FROM low_stock_alerts WHERE variant_id IN (SELECT id FROM variants WHERE product_id=target);
 DELETE FROM product_images WHERE product_id=target;
 DELETE FROM media_assets WHERE product_id=target;
 DELETE FROM product_options WHERE product_id=target;
 DELETE FROM variants WHERE product_id=target;
 DELETE FROM slug_redirects WHERE product_id=target;
 DELETE FROM products WHERE id=target;
END;
$$;
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION catalogue_purge_product(uuid) SET search_path = %I, pg_temp',
   current_schema());
END;
$$;
