-- Brand names are unique case-insensitively, including trashed rows (restore never collides).
CREATE UNIQUE INDEX brands_name_normalized ON brands (lower(name));

-- A published product needs a live (non-trashed) brand and category. The parent rows are locked
-- FOR SHARE, so a concurrent trash (which locks the parent FOR UPDATE and then counts published
-- products) and a publish serialize: whichever commits second sees the other. Trash never locks
-- product rows, so taking the parent after the product row here cannot deadlock with it.
CREATE FUNCTION products_live_parents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE brand_trashed BOOLEAN; category_trashed BOOLEAN;
BEGIN
 IF NEW.status<>'published' THEN RETURN NEW; END IF;
 SELECT deleted_at IS NOT NULL INTO brand_trashed FROM brands WHERE id=NEW.brand_id FOR SHARE;
 SELECT deleted_at IS NOT NULL INTO category_trashed FROM categories WHERE id=NEW.category_id FOR SHARE;
 IF brand_trashed OR category_trashed THEN
  RAISE EXCEPTION 'Published products need a live brand and category' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER products_live_parents BEFORE INSERT OR UPDATE ON products
 FOR EACH ROW EXECUTE FUNCTION products_live_parents();
