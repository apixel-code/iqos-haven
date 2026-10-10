-- Product image gallery (roadmap step 50, ADR 0020). A gallery image is exactly one processed
-- (`ready`) media asset of the same product; its public form is the sanitized large derivative.
-- Removing an image marks its asset `removed`, which frees the upload slot and keeps history.
-- Pre-launch: product_images has no rows yet (no write path before this step), so NOT NULL is safe.
ALTER TABLE product_images ADD COLUMN media_asset_id UUID NOT NULL UNIQUE
 REFERENCES media_assets(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE media_assets DROP CONSTRAINT media_assets_state_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_state_check
 CHECK (state IN ('pending','uploaded','processing','ready','rejected','expired','removed'));

CREATE FUNCTION product_images_ready_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- FOR SHARE: the asset cannot leave `ready` (see the guard below) until this commits.
 IF NOT EXISTS (
   SELECT 1 FROM media_assets
   WHERE id=NEW.media_asset_id AND product_id=NEW.product_id AND state='ready' FOR SHARE) THEN
  RAISE EXCEPTION 'Gallery images must be ready assets of the same product' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_images_ready_asset BEFORE INSERT OR UPDATE OF media_asset_id, product_id
 ON product_images FOR EACH ROW EXECUTE FUNCTION product_images_ready_asset();

-- An attached asset stays `ready` and on its product; the gallery row is removed first.
CREATE FUNCTION media_assets_attached_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.state<>'ready' OR NEW.product_id<>OLD.product_id)
   AND EXISTS (SELECT 1 FROM product_images WHERE media_asset_id=OLD.id) THEN
  RAISE EXCEPTION 'Attached gallery assets must stay ready' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER media_assets_attached_guard BEFORE UPDATE OF state, product_id ON media_assets
 FOR EACH ROW WHEN (OLD.state='ready') EXECUTE FUNCTION media_assets_attached_guard();

