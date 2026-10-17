-- Manual orders (roadmap step 88, ADR 0056): an order that starts Confirmed records how the
-- customer confirmed it. Only a staff-entered order may start Confirmed (orders guard), and its
-- first history row must say why.
ALTER TABLE order_status_history ADD CONSTRAINT order_history_confirmed_start_evidence CHECK (
  NOT (from_status IS NULL AND to_status = 'confirmed') OR reason IS NOT NULL);
