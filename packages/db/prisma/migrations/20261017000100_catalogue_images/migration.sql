-- Brand logos and category images, and the Owner's purge of brands and categories
-- (parity G-A7, ADR 0091).

-- 1. A third media purpose: catalogue images (brand logos, category images), with no product.
ALTER TABLE media_assets DROP CONSTRAINT media_asset_purpose;
ALTER TABLE media_assets ADD CONSTRAINT media_asset_purpose CHECK (
  purpose IN ('product', 'content', 'catalogue') AND (purpose = 'product') = (product_id IS NOT NULL));
CREATE INDEX media_assets_catalogue ON media_assets (created_at, id) WHERE purpose = 'catalogue';

-- 2. The never-used free-text keys give way to references to processed assets.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM brands WHERE logo_key IS NOT NULL)
    OR EXISTS (SELECT 1 FROM categories WHERE image_key IS NOT NULL) THEN
  RAISE EXCEPTION 'brands.logo_key or categories.image_key holds a value: move it first';
 END IF;
END;
$$;
ALTER TABLE brands DROP COLUMN logo_key;
ALTER TABLE categories DROP COLUMN image_key;
ALTER TABLE brands ADD COLUMN logo_asset_id UUID
  REFERENCES media_assets (id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE categories ADD COLUMN image_asset_id UUID
  REFERENCES media_assets (id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX brands_logo_asset ON brands (logo_asset_id) WHERE logo_asset_id IS NOT NULL;
CREATE INDEX categories_image_asset ON categories (image_asset_id) WHERE image_asset_id IS NOT NULL;

-- 3. Only a ready catalogue image can be referenced, and a referenced one stays ready.
CREATE FUNCTION catalogue_image_reference_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
 -- The referencing column is the trigger's argument: each table has only its own column.
 asset UUID := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
 IF asset IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM media_assets WHERE id = asset AND purpose = 'catalogue' AND state = 'ready') THEN
  RAISE EXCEPTION 'Only a ready catalogue image can be used' USING ERRCODE = 'IH005';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER brands_logo_reference BEFORE INSERT OR UPDATE OF logo_asset_id ON brands
  FOR EACH ROW EXECUTE FUNCTION catalogue_image_reference_check('logo_asset_id');
CREATE TRIGGER categories_image_reference BEFORE INSERT OR UPDATE OF image_asset_id ON categories
  FOR EACH ROW EXECUTE FUNCTION catalogue_image_reference_check('image_asset_id');

CREATE FUNCTION catalogue_image_in_use_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.state <> 'ready' OR NEW.purpose <> 'catalogue' OR NEW.product_id IS NOT NULL)
    AND (EXISTS (SELECT 1 FROM brands WHERE logo_asset_id = OLD.id)
      OR EXISTS (SELECT 1 FROM categories WHERE image_asset_id = OLD.id)) THEN
  RAISE EXCEPTION 'A catalogue image in use stays ready' USING ERRCODE = 'IH006';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER media_assets_catalogue_guard BEFORE UPDATE OF state, purpose, product_id
  ON media_assets FOR EACH ROW WHEN (OLD.state = 'ready' AND OLD.purpose = 'catalogue')
  EXECUTE FUNCTION catalogue_image_in_use_guard();

-- 4. Owner purge of a trashed brand or category with no products (trashed ones included):
--    redirects go with it, and its image is released (removed) when nothing else uses it.
--    The runtime role cannot DELETE catalogue rows (step 41): this function is the only path.
CREATE FUNCTION catalogue_purge_parent(kind TEXT, target UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
 image UUID;
BEGIN
 IF kind = 'brand' THEN
  SELECT logo_asset_id INTO image FROM brands WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown brand' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM brands WHERE id = target AND deleted_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Only a trashed brand can be purged' USING ERRCODE = 'IH003';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE brand_id = target) THEN
   RAISE EXCEPTION 'Brand still has products' USING ERRCODE = 'IH004';
  END IF;
  DELETE FROM slug_redirects WHERE brand_id = target;
  DELETE FROM brands WHERE id = target;
 ELSIF kind = 'category' THEN
  SELECT image_asset_id INTO image FROM categories WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown category' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM categories WHERE id = target AND deleted_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Only a trashed category can be purged' USING ERRCODE = 'IH003';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE category_id = target) THEN
   RAISE EXCEPTION 'Category still has products' USING ERRCODE = 'IH004';
  END IF;
  DELETE FROM slug_redirects WHERE category_id = target;
  DELETE FROM categories WHERE id = target;
 ELSE
  RAISE EXCEPTION 'Unknown kind' USING ERRCODE = '22023';
 END IF;
 IF image IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM brands WHERE logo_asset_id = image)
    AND NOT EXISTS (SELECT 1 FROM categories WHERE image_asset_id = image) THEN
  UPDATE media_assets SET state = 'removed', version = version + 1,
    updated_at = statement_timestamp() WHERE id = image;
 END IF;
 RETURN image;
END;
$$;
DO $$
BEGIN
 EXECUTE format('ALTER FUNCTION catalogue_purge_parent(text, uuid) SET search_path = %I, pg_temp',
   current_schema());
 REVOKE ALL ON FUNCTION catalogue_purge_parent(text, uuid) FROM PUBLIC;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  GRANT EXECUTE ON FUNCTION catalogue_purge_parent(text, uuid) TO ih_app;
 END IF;
END;
$$;
