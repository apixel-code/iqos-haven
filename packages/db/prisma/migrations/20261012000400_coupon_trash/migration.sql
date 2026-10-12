-- Coupons are never hard-deleted (step 69): the Owner moves one to Trash and may restore it.
-- A trashed coupon is always inactive, so no order can use it, and its code stays reserved.
ALTER TABLE coupons ADD COLUMN deleted_at TIMESTAMPTZ(6);
ALTER TABLE coupons ADD CONSTRAINT coupon_trashed_inactive CHECK (deleted_at IS NULL OR NOT active);
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  GRANT UPDATE (deleted_at) ON coupons TO ih_app;
 END IF;
END;
$$;
