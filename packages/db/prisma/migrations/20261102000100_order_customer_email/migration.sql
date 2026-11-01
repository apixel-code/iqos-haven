-- Customer email at checkout (ADR 0102). The shopper's email is kept on the order only, next to
-- the name and phone it was placed with, so the order confirmation can be sent to it. Expand
-- only: nullable, so orders placed before this release and staff-entered orders without one stay
-- valid, and the previous release (which never writes it) still runs on this schema.
ALTER TABLE orders ADD COLUMN customer_email VARCHAR(254);
ALTER TABLE orders ADD CONSTRAINT order_customer_email CHECK (
  customer_email IS NULL OR (
    length(customer_email) BETWEEN 3 AND 254
    AND customer_email = lower(btrim(customer_email))
    AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
