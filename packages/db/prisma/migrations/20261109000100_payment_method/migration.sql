-- Payment method chosen at checkout (ADR 0111, client 2026-11-09). No payment gateway: the
-- shopper says how they will pay (cash on delivery, bank transfer or an online payment link the
-- team sends) and staff arrange it. Like the other order contents, it may change in a controlled
-- edit while the order is Pending or Confirmed and is fixed after that (orders_guard trigger).
--
-- Expand only: the previous release never names the column, so its inserts take the default and
-- every earlier order reads as cash on delivery, which is what it was.
ALTER TABLE orders ADD COLUMN payment_method varchar(16) NOT NULL DEFAULT 'cash_on_delivery';
ALTER TABLE orders ADD CONSTRAINT order_payment_method
  CHECK (payment_method IN ('cash_on_delivery', 'bank_transfer', 'online_payment'));
