-- Reference-aware hard purge of a trashed product (roadmap step 51, ADR 0021). The runtime role
-- cannot DELETE catalogue rows (step 41) or media_assets (step 48); this SECURITY DEFINER function
-- is the only purge path. It refuses unless the product is trashed and nothing historical refers
-- to it (stock ledger now; order lines when orders arrive, via their RESTRICT foreign keys), then
-- deletes the product's own rows and returns the storage keys the caller removes after commit.
CREATE FUNCTION catalogue_purge_product(target UUID)
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
 -- Storage objects to remove after commit: derivatives and any unpurged quarantine originals.
 RETURN QUERY
  SELECT 'media'::text, d.value FROM media_assets a, jsonb_each_text(a.derivative_keys) d
  WHERE a.product_id=target
  UNION ALL
  SELECT 'quarantine'::text, a.quarantine_key FROM media_assets a
  WHERE a.product_id=target AND a.quarantine_purged_at IS NULL;
 DELETE FROM product_images WHERE product_id=target;
 DELETE FROM media_assets WHERE product_id=target;
 DELETE FROM product_options WHERE product_id=target;
 DELETE FROM variants WHERE product_id=target;
 DELETE FROM slug_redirects WHERE product_id=target;
 DELETE FROM products WHERE id=target;
END;
$$;
-- Pin the lookup path to this schema (then pg_temp last) so callers cannot shadow tables.
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION catalogue_purge_product(uuid) SET search_path = %I, pg_temp',
   current_schema());
 REVOKE ALL ON FUNCTION catalogue_purge_product(uuid) FROM PUBLIC;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  GRANT EXECUTE ON FUNCTION catalogue_purge_product(uuid) TO ih_app;
 END IF;
END;
$$;
