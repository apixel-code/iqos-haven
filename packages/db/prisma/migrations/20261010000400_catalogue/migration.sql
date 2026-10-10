-- Additive catalogue foundation; no catalogue, tax or stock seeds.
CREATE TABLE brands (
id UUID PRIMARY KEY DEFAULT uuidv7(),
 name VARCHAR(150) NOT NULL CHECK (name=btrim(name) AND length(name)>0),
 slug VARCHAR(150) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 active BOOLEAN NOT NULL DEFAULT false,
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order>=0),
 seo JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(seo)='object' AND octet_length(seo::text)<=4096),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 deleted_at TIMESTAMPTZ(6),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 logo_key VARCHAR(512) CHECK (logo_key IS NULL OR (logo_key ~ '^[a-zA-Z0-9]+([/_-][a-zA-Z0-9]+)*\.[a-zA-Z0-9]+$')),
 description TEXT NOT NULL DEFAULT '' CHECK (length(description)<=10000)
);
CREATE TABLE categories (
id UUID PRIMARY KEY DEFAULT uuidv7(),
 name VARCHAR(150) NOT NULL CHECK (name=btrim(name) AND length(name)>0),
 slug VARCHAR(150) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 active BOOLEAN NOT NULL DEFAULT false,
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order>=0),
 seo JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(seo)='object' AND octet_length(seo::text)<=4096),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 deleted_at TIMESTAMPTZ(6),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 image_key VARCHAR(512) CHECK (image_key IS NULL OR (image_key ~ '^[a-zA-Z0-9]+([/_-][a-zA-Z0-9]+)*\.[a-zA-Z0-9]+$'))
);
CREATE TABLE products (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 name VARCHAR(150) NOT NULL CHECK (name=btrim(name) AND length(name)>0),
 slug VARCHAR(150) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 type VARCHAR(16) NOT NULL CHECK (type IN ('disposable','kit')),
 puff_count INTEGER CHECK (puff_count>0),
 status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
 base_price_fils BIGINT NOT NULL CHECK (base_price_fils BETWEEN 0 AND 1000000000),
 compare_at_price_fils BIGINT CHECK (compare_at_price_fils BETWEEN 0 AND 1000000000),
 tax_treatment_ref VARCHAR(100),
 tax_treatment_version INTEGER CHECK (tax_treatment_version>0),
 specs JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(specs)='object' AND octet_length(specs::text)<=16000),
 description TEXT NOT NULL DEFAULT '' CHECK (length(description)<=20000),
 seo JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(seo)='object' AND octet_length(seo::text)<=4096),
 is_new BOOLEAN NOT NULL DEFAULT false,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 deleted_at TIMESTAMPTZ(6),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 CHECK ((tax_treatment_ref IS NULL) = (tax_treatment_version IS NULL)),
 CHECK (tax_treatment_ref IS NULL OR (length(btrim(tax_treatment_ref))>0 AND tax_treatment_ref=btrim(tax_treatment_ref))),
 CHECK (compare_at_price_fils IS NULL OR compare_at_price_fils>base_price_fils),
 CHECK (status<>'published' OR (tax_treatment_ref IS NOT NULL AND deleted_at IS NULL AND base_price_fils>0
  AND (type<>'disposable' OR puff_count IS NOT NULL)))
);
-- Canonical option identifiers/values: sorted JSONB keys, trimmed lower-case strings.
CREATE FUNCTION catalogue_attributes_valid(attributes JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item RECORD;
BEGIN
 IF jsonb_typeof(attributes)<>'object' OR octet_length(attributes::text)>2000 OR (SELECT count(*) FROM jsonb_object_keys(attributes))>8 THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(attributes) LOOP
  IF item.key !~ '^[a-z][a-z0-9_-]{0,63}$' OR jsonb_typeof(item.value)<>'string'
   OR length(item.value #>> '{}') NOT BETWEEN 1 AND 100
   OR (item.value #>> '{}')<>lower(btrim(item.value #>> '{}')) OR (item.value #>> '{}') ~ '^[[:space:]]|[[:space:]]$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE FUNCTION catalogue_option_values_valid(values_json JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item JSONB; n INTEGER;
BEGIN
 IF jsonb_typeof(values_json)<>'array' THEN RETURN false; END IF;
 n=jsonb_array_length(values_json);
 IF n NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(values_json) LOOP
  IF jsonb_typeof(item)<>'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 100
   OR (item #>> '{}')<>lower(btrim(item #>> '{}')) OR (item #>> '{}') ~ '^[[:space:]]|[[:space:]]$' THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT value) FROM jsonb_array_elements(values_json))=n;
END;
$$;
CREATE TABLE product_options (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 name VARCHAR(64) NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
 allowed_values JSONB NOT NULL CHECK (catalogue_option_values_valid(allowed_values)),
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order>=0),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(product_id,name)
);
CREATE TABLE variants (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 sku VARCHAR(64) NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
 attributes JSONB NOT NULL DEFAULT '{}' CHECK (catalogue_attributes_valid(attributes)),
 option_signature TEXT GENERATED ALWAYS AS (attributes::text) STORED,
 price_override_fils BIGINT CHECK (price_override_fils BETWEEN 0 AND 1000000000),
 stock_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (stock_on_hand>=0),
 low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold>=0),
 active BOOLEAN NOT NULL DEFAULT false,
 is_default BOOLEAN NOT NULL DEFAULT false,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(product_id,option_signature)
);
CREATE UNIQUE INDEX variants_one_default ON variants(product_id) WHERE is_default;
-- Stock changes only through the stock ledger (step 51): new variants start at zero and any later
-- change needs the transaction-local ih.stock_ledger flag, which only the ledger service sets in
-- the same transaction as its stock_movements row. A guard against stray writes, not a privilege.
CREATE FUNCTION variants_stock_ledger_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.stock_on_hand<>0 THEN
   RAISE EXCEPTION 'Variant stock starts at zero; use the stock ledger' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.stock_on_hand IS DISTINCT FROM OLD.stock_on_hand
   AND coalesce(current_setting('ih.stock_ledger', true), '')<>'1' THEN
  RAISE EXCEPTION 'Variant stock changes only through the stock ledger' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER variants_stock_ledger_only BEFORE INSERT OR UPDATE OF stock_on_hand ON variants
 FOR EACH ROW EXECUTE FUNCTION variants_stock_ledger_only();
CREATE INDEX variants_availability ON variants(product_id,active);
-- Asset keys are syntactically constrained placeholders; media_assets and readiness checks arrive in step 48–50.
CREATE TABLE product_images (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 asset_key VARCHAR(512) NOT NULL CHECK (asset_key ~ '^[a-zA-Z0-9]+([/_-][a-zA-Z0-9]+)*\.[a-zA-Z0-9]+$'),
 is_primary BOOLEAN NOT NULL DEFAULT false,
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order>=0),
 alt VARCHAR(500) NOT NULL DEFAULT '',
 width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 20000),
 height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 20000),
 mime VARCHAR(32) NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(product_id,asset_key)
);
CREATE UNIQUE INDEX product_images_one_primary ON product_images(product_id) WHERE is_primary;
CREATE INDEX product_images_order ON product_images(product_id,sort_order,id);
CREATE TABLE slug_redirects (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 entity_type VARCHAR(16) NOT NULL CHECK (entity_type IN ('brand','category','product')),
 old_slug VARCHAR(150) NOT NULL CHECK (old_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 brand_id UUID REFERENCES brands(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 category_id UUID REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 product_id UUID REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(entity_type,old_slug),
 CHECK ((entity_type='brand' AND brand_id IS NOT NULL AND category_id IS NULL AND product_id IS NULL)
 OR (entity_type='category' AND category_id IS NOT NULL AND brand_id IS NULL AND product_id IS NULL)
 OR (entity_type='product' AND product_id IS NOT NULL AND brand_id IS NULL AND category_id IS NULL))
);
-- Direct entity targets (never redirect-to-redirect) resolve current slugs and cannot form chains/cycles.
-- Serialize slug claims across live rows and redirect aliases in each route namespace.
CREATE FUNCTION catalogue_slug_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT; claimed TEXT; source TEXT; collision BOOLEAN;
BEGIN
 IF TG_TABLE_NAME='slug_redirects' THEN
  kind=NEW.entity_type; claimed=NEW.old_slug;
 ELSE
  kind=CASE TG_TABLE_NAME WHEN 'brands' THEN 'brand' WHEN 'categories' THEN 'category' ELSE 'product' END;
  claimed=NEW.slug;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalogue-slug:'||kind||':'||claimed,0));
 IF TG_TABLE_NAME='slug_redirects' THEN
  source=CASE kind WHEN 'brand' THEN 'brands' WHEN 'category' THEN 'categories' ELSE 'products' END;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE slug=$1)',source) INTO collision USING claimed;
 ELSE
  SELECT EXISTS(SELECT 1 FROM slug_redirects WHERE entity_type=kind AND old_slug=claimed) INTO collision;
 END IF;
 IF collision THEN RAISE EXCEPTION 'Catalogue slug is already reserved' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER brands_slug_claim BEFORE INSERT OR UPDATE OF slug ON brands FOR EACH ROW EXECUTE FUNCTION catalogue_slug_claim();
CREATE TRIGGER categories_slug_claim BEFORE INSERT OR UPDATE OF slug ON categories FOR EACH ROW EXECUTE FUNCTION catalogue_slug_claim();
CREATE TRIGGER products_slug_claim BEFORE INSERT OR UPDATE OF slug ON products FOR EACH ROW EXECUTE FUNCTION catalogue_slug_claim();
CREATE TRIGGER redirects_slug_claim BEFORE INSERT OR UPDATE ON slug_redirects FOR EACH ROW EXECUTE FUNCTION catalogue_slug_claim();
CREATE INDEX products_published_category ON products(category_id,created_at DESC,id DESC) WHERE status='published' AND deleted_at IS NULL;
CREATE INDEX products_published_brand ON products(brand_id,created_at DESC,id DESC) WHERE status='published' AND deleted_at IS NULL;
CREATE INDEX products_brand ON products(brand_id);
CREATE INDEX products_category ON products(category_id);
CREATE INDEX redirects_brand ON slug_redirects(brand_id);
CREATE INDEX redirects_category ON slug_redirects(category_id);
CREATE INDEX redirects_product ON slug_redirects(product_id);
-- Runtime role: catalogue rows are soft-deleted/archived; hard purge is an Owner-only reference-
-- checked command (later step) and never a TRUNCATE.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON brands, categories, products, variants FROM ih_app;
  REVOKE TRUNCATE ON product_options, product_images, slug_redirects FROM ih_app;
 END IF;
END;
$$;
-- Repository/service layer (steps 42-51) owns: version bumps and updated_at on every update,
-- cross-row publish/image-count/option membership checks under the product lock, and deleting an
-- entity's own redirect in the same transaction when a rename reclaims its previous slug.
