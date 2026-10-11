-- Product search projection (roadmap step 60, architecture §5 "Search", ADR 0029).
-- One row per product with the text shoppers search: product, brand and category names, the
-- product type, puff count and the option values of ACTIVE variants. It is derived data kept
-- current by triggers; it grants no visibility (search joins the usual published/active rules).

-- pg_trgm lives in "public" and is always referenced schema-qualified, so it works whatever
-- schema the application tables are in. The lock serializes concurrent installers.
SELECT pg_advisory_xact_lock(hashtext('ih:create-extension:pg_trgm'));
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
DO $$
BEGIN
 IF (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
     WHERE e.extname='pg_trgm') IS DISTINCT FROM 'public' THEN
  RAISE EXCEPTION 'pg_trgm must be installed in schema public';
 END IF;
END;
$$;

CREATE TABLE product_search (
 -- Derived projection, not history: it goes with its product (the purge function deletes the
 -- product row; nothing else may delete here).
 product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE ON UPDATE RESTRICT,
 search_text TEXT NOT NULL CHECK (char_length(search_text)<=4000),
 document TSVECTOR NOT NULL,
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX product_search_document ON product_search USING GIN (document);
CREATE INDEX product_search_trgm ON product_search USING GIN (search_text public.gin_trgm_ops);

CREATE FUNCTION catalogue_refresh_search(target UUID) RETURNS void
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

CREATE FUNCTION product_search_on_product() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 PERFORM catalogue_refresh_search(NEW.id);
 RETURN NULL;
END;
$$;
CREATE FUNCTION product_search_on_variant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN PERFORM catalogue_refresh_search(OLD.product_id); END IF;
 IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id)
  THEN PERFORM catalogue_refresh_search(NEW.product_id); END IF;
 RETURN NULL;
END;
$$;
CREATE FUNCTION product_search_on_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF TG_TABLE_NAME = 'brands' THEN
  -- Sorted IDs: the same lock order as every other multi-row catalogue write.
  PERFORM catalogue_refresh_search(x.id)
  FROM (SELECT id FROM products WHERE brand_id=NEW.id ORDER BY id) x;
 ELSE
  PERFORM catalogue_refresh_search(x.id)
  FROM (SELECT id FROM products WHERE category_id=NEW.id ORDER BY id) x;
 END IF;
 RETURN NULL;
END;
$$;

CREATE TRIGGER product_search_product AFTER INSERT OR UPDATE OF name, brand_id, category_id, type, puff_count
 ON products FOR EACH ROW EXECUTE FUNCTION product_search_on_product();
CREATE TRIGGER product_search_variant AFTER INSERT OR DELETE OR UPDATE OF attributes, active, product_id
 ON variants FOR EACH ROW EXECUTE FUNCTION product_search_on_variant();
CREATE TRIGGER product_search_brand AFTER UPDATE OF name ON brands
 FOR EACH ROW EXECUTE FUNCTION product_search_on_parent();
CREATE TRIGGER product_search_category AFTER UPDATE OF name ON categories
 FOR EACH ROW EXECUTE FUNCTION product_search_on_parent();

-- Existing products.
SELECT catalogue_refresh_search(id) FROM products;

-- Pin lookup paths to this schema; the functions are reached only through the triggers. The
-- runtime role reads the projection and never writes it.
DO $$
DECLARE fn TEXT;
BEGIN
 FOREACH fn IN ARRAY ARRAY['catalogue_refresh_search(uuid)', 'product_search_on_product()',
   'product_search_on_variant()', 'product_search_on_parent()'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn, current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON product_search FROM ih_app;
  GRANT SELECT ON product_search TO ih_app;
 END IF;
END;
$$;
