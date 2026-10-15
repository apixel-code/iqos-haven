-- Admin customer list (roadmap step 90, ADR 0058): customers who have ordered, newest first.
CREATE INDEX customers_with_orders ON customers (created_at DESC, id DESC)
  WHERE first_order_at IS NOT NULL;
