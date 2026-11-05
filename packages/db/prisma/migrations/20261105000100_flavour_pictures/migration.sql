-- Flavour pictures (ADR 0107, Marina 2026-11-05). A gallery image may show one variant (a TEREA
-- flavour pack); choosing that flavour on the product page brings its picture forward. At most one
-- picture per variant, and only a variant of the same product (composite key).
--
-- Expand only: a nullable column the previous release neither reads nor writes.
CREATE UNIQUE INDEX variants_product_id_id ON variants (product_id, id);

ALTER TABLE product_images ADD COLUMN variant_id uuid;
ALTER TABLE product_images ADD CONSTRAINT product_images_variant_fk
  FOREIGN KEY (product_id, variant_id) REFERENCES variants (product_id, id)
  ON DELETE SET NULL (variant_id) ON UPDATE RESTRICT;
CREATE UNIQUE INDEX product_images_one_per_variant ON product_images (variant_id)
  WHERE variant_id IS NOT NULL;
