-- Heated-tobacco catalogue (ADR 0101). Two product types are added: `device` (an IQOS device,
-- sold in colours) and `sticks` (a TEREA version, sold in flavours). Expand only: the vape types
-- stay valid, so the previous release still runs on this schema. Neither new type needs a puff
-- count to be published; the publish rule is unchanged.
DO $$
DECLARE
  old_check text;
BEGIN
  SELECT conname INTO STRICT old_check FROM pg_constraint
   WHERE conrelid = 'products'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%type%'
     AND pg_get_constraintdef(oid) LIKE '%''kit''%'
     AND pg_get_constraintdef(oid) NOT LIKE '%published%';
  EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', old_check);
END;
$$;
ALTER TABLE products ADD CONSTRAINT products_type
  CHECK (type IN ('disposable','kit','device','sticks'));

-- Search words per type, so "iqos", "iluma", "terea", "heets" and "sticks" find the new products.
CREATE OR REPLACE FUNCTION catalogue_refresh_search(target UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
 p RECORD;
 attrs TEXT;
 kind TEXT;
 puffs TEXT;
BEGIN
 SELECT pr.name, pr.type, pr.puff_count, b.name AS brand, c.name AS category INTO p
 FROM products pr JOIN brands b ON b.id=pr.brand_id JOIN categories c ON c.id=pr.category_id
 WHERE pr.id=target;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT coalesce(string_agg(DISTINCT lower(e.value), ' '), '') INTO attrs
 FROM variants v, jsonb_each_text(v.attributes) e WHERE v.product_id=target AND v.active;
 attrs := left(attrs, 2000);
 kind := CASE p.type WHEN 'disposable' THEN 'disposable disposables vape'
                     WHEN 'device' THEN 'device devices iqos iluma heated tobacco'
                     WHEN 'sticks' THEN 'sticks stick terea heets heated tobacco pack carton'
                     ELSE 'kit kits vape pod device' END;
 puffs := CASE WHEN p.puff_count IS NULL THEN ''
  ELSE p.puff_count::text
   || CASE WHEN p.puff_count>=1000 THEN ' ' || round(p.puff_count/1000.0)::int::text || 'k' ELSE '' END
   || ' puffs' END;
 INSERT INTO product_search (product_id, search_text, document)
 VALUES (target,
  left(lower(concat_ws(' ', p.name, p.brand, p.category, kind, puffs, attrs)), 4000),
  setweight(to_tsvector('simple', lower(p.name)), 'A')
   || setweight(to_tsvector('simple', lower(p.brand)), 'A')
   || setweight(to_tsvector('simple', attrs), 'B')
   || setweight(to_tsvector('simple', lower(concat_ws(' ', p.category, kind, puffs))), 'C'))
 ON CONFLICT (product_id) DO UPDATE
  SET search_text=EXCLUDED.search_text, document=EXCLUDED.document,
      updated_at=statement_timestamp();
END;
$$;
-- CREATE OR REPLACE clears the function's settings: pin the lookup path again.
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION catalogue_refresh_search(uuid) SET search_path = %I, pg_temp',
   current_schema());
 REVOKE ALL ON FUNCTION catalogue_refresh_search(uuid) FROM PUBLIC;
END;
$$;
