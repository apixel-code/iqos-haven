-- Unfiltered/date-bounded admin order pages use the same stable newest-first key as status pages.
CREATE INDEX orders_created ON orders (created_at DESC, id DESC);
