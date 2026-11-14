-- Category text (ADR 0116, SEO plan 2026-11-14): a category gets the same free text a brand
-- has, shown under the heading on its store page and used for its search description.
--
-- Expand only: a new column with a constant default (no table rewrite, 13 rows on production).
-- The previous release neither reads nor writes it; its updates leave the text as it is.
ALTER TABLE categories
  ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description)<=10000);
