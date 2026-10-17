-- Daily analytics tables (roadmap step 106, ADR 0072; architecture §5, §14). Each row is a
-- recomputed Dubai-day slice of authoritative data, replaced whole by a rollup: running a
-- rollup again gives the same rows, never added totals. Amounts are integer fils (AED).

-- Booked (placement day), delivered (delivery day) and collected (collection day) kept apart.
CREATE TABLE sales_daily (
  day DATE PRIMARY KEY,
  placed_orders INTEGER NOT NULL,
  cancelled_orders INTEGER NOT NULL,
  booked_orders INTEGER NOT NULL,
  booked_net_fils BIGINT NOT NULL,
  booked_delivery_fils BIGINT NOT NULL,
  booked_total_fils BIGINT NOT NULL,
  cancelled_total_fils BIGINT NOT NULL,
  delivered_orders INTEGER NOT NULL,
  delivered_net_fils BIGINT NOT NULL,
  delivered_delivery_fils BIGINT NOT NULL,
  delivered_total_fils BIGINT NOT NULL,
  collected_orders INTEGER NOT NULL,
  collected_fils BIGINT NOT NULL,
  definition_version INTEGER NOT NULL,
  computed_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT sales_daily_counts CHECK (placed_orders >= 0 AND cancelled_orders >= 0
    AND booked_orders >= 0 AND placed_orders = booked_orders + cancelled_orders
    AND delivered_orders >= 0 AND collected_orders >= 0),
  CONSTRAINT sales_daily_money CHECK (booked_net_fils >= 0 AND booked_delivery_fils >= 0
    AND booked_total_fils >= 0 AND cancelled_total_fils >= 0 AND delivered_net_fils >= 0
    AND delivered_delivery_fils >= 0 AND delivered_total_fils >= 0 AND collected_fils >= 0)
);

-- Per product and the brand as it was on the order (the item's snapshot), so moving a
-- product to another brand never moves its past sales.
CREATE TABLE product_sales_daily (
  day DATE NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  brand_name VARCHAR(150) NOT NULL,
  ordered_units INTEGER NOT NULL,
  ordered_net_fils BIGINT NOT NULL,
  delivered_units INTEGER NOT NULL,
  delivered_net_fils BIGINT NOT NULL,
  delivered_discount_fils BIGINT NOT NULL,
  computed_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT product_sales_daily_key PRIMARY KEY (day, product_id, brand_name),
  CONSTRAINT product_sales_daily_values CHECK (ordered_units >= 0 AND ordered_net_fils >= 0
    AND delivered_units >= 0 AND delivered_net_fils >= 0 AND delivered_discount_fils >= 0)
);
CREATE INDEX product_sales_daily_product ON product_sales_daily (product_id, day);

-- Searches per normalized term; '' stands for terms not kept (ADR 0069).
CREATE TABLE search_daily (
  day DATE NOT NULL,
  term VARCHAR(100) NOT NULL,
  searches INTEGER NOT NULL,
  zero_results INTEGER NOT NULL,
  result_total BIGINT NOT NULL,
  computed_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT search_daily_key PRIMARY KEY (day, term),
  CONSTRAINT search_daily_values CHECK (searches > 0 AND zero_results >= 0
    AND zero_results <= searches AND result_total >= 0)
);

-- Saved-list adds and removes per product: device activity, not unique customers.
CREATE TABLE wishlist_daily (
  day DATE NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  adds INTEGER NOT NULL,
  removes INTEGER NOT NULL,
  computed_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT wishlist_daily_key PRIMARY KEY (day, product_id),
  CONSTRAINT wishlist_daily_values CHECK (adds >= 0 AND removes >= 0 AND adds + removes > 0)
);

-- Rollups read a day by delivery and by collection time.
CREATE INDEX orders_delivered_at ON orders (delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX order_collection_records_time ON order_collection_records (collected_at);
