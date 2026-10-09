-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(64) NOT NULL,
    "description" VARCHAR(200) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "role_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "totp_secret_encrypted" BYTEA,
    "last_active_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" VARCHAR(32),
    "ip_network" VARCHAR(64),
    "client_label" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE INDEX "staff_users_role_id_idx" ON "staff_users"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (reviewed).
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_key_ck" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT "roles_name_ck" CHECK (length(btrim("name")) > 0);
ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_key_ck" CHECK ("key" ~ '^[a-z]+(\.[a-z_]+)+$'),
  ADD CONSTRAINT "permissions_description_ck" CHECK (length(btrim("description")) > 0);
ALTER TABLE "staff_users"
  -- One normalized address per account (trimmed, lower case) so uniqueness is case-insensitive.
  ADD CONSTRAINT "staff_users_email_normalized_ck" CHECK ("email" = lower(btrim("email"))),
  ADD CONSTRAINT "staff_users_email_shape_ck" CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Only argon2id hashes; a plaintext or other-format value can never be stored.
  ADD CONSTRAINT "staff_users_password_hash_ck" CHECK ("password_hash" LIKE '$argon2id$%'),
  ADD CONSTRAINT "staff_users_name_ck" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "staff_users_version_ck" CHECK ("version" >= 1);
ALTER TABLE "sessions"
  -- SHA-256 of a 256-bit random token; the token itself is never stored.
  ADD CONSTRAINT "sessions_token_hash_ck" CHECK (octet_length("token_hash") = 32),
  -- Absolute lifetime at most seven days; idle expiry is enforced against last_seen_at.
  ADD CONSTRAINT "sessions_expiry_ck" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days'
  ),
  ADD CONSTRAINT "sessions_last_seen_ck" CHECK ("last_seen_at" >= "created_at"),
  ADD CONSTRAINT "sessions_revoked_ck" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
  ADD CONSTRAINT "sessions_revoke_reason_ck" CHECK ("revoke_reason" IS NULL OR "revoke_reason" ~ '^[a-z_]{2,32}$');

-- Active sessions per user (revocation on password reset, deactivation, role change).
CREATE INDEX "sessions_active_user_idx" ON "sessions" ("user_id") WHERE "revoked_at" IS NULL;

-- Launch roles and explicit permission grants. Must equal @ih/domain PERMISSIONS /
-- ROLE_PERMISSIONS (enforced by an integration test). No wildcard grant exists.
INSERT INTO "roles" ("key", "name") VALUES ('owner', 'Owner'), ('staff', 'Staff');

INSERT INTO "permissions" ("key", "description") VALUES
  ('orders.read', 'View orders and their history'),
  ('orders.create', 'Create manual orders'),
  ('orders.edit', 'Edit orders before dispatch'),
  ('orders.transition', 'Move orders through normal status transitions'),
  ('orders.cancel_before_dispatch', 'Cancel an order before it is handed to the courier'),
  ('orders.collect', 'Record cash-on-delivery collection'),
  ('orders.cancel_after_dispatch', 'Cancel after handoff (return flow)'),
  ('orders.collection_correct', 'Correct a recorded collection'),
  ('catalog.read', 'View products, variants, brands and categories'),
  ('catalog.write', 'Create and edit catalogue entries'),
  ('catalog.publish', 'Publish and unpublish catalogue entries'),
  ('catalog.trash', 'Move catalogue entries to trash and restore them'),
  ('catalog.purge', 'Permanently purge catalogue entries (reference-checked)'),
  ('media.upload', 'Upload catalogue images'),
  ('inventory.read', 'View stock levels and movements'),
  ('inventory.adjust', 'Make reasoned stock adjustments'),
  ('customers.read', 'View operational customer contact and order history'),
  ('customers.financial_read', 'View customer aggregate spend'),
  ('customers.export', 'Export customer data'),
  ('seo.write', 'Edit SEO fields and redirects'),
  ('seo.reports', 'View SEO reports'),
  ('dashboard.financial_read', 'View revenue and analytics'),
  ('reports.read', 'View reports'),
  ('reports.export', 'Export reports'),
  ('reviews.moderate', 'Approve or reject reviews'),
  ('coupons.manage', 'Manage coupons'),
  ('content.manage', 'Edit and publish storefront content'),
  ('settings.manage', 'Change store settings'),
  ('delivery.manage', 'Manage delivery areas, fees and ETAs'),
  ('staff.manage', 'Invite, edit and deactivate staff'),
  ('audit.read', 'View the audit trail'),
  ('effects.replay', 'Inspect and replay dead background effects'),
  ('notifications.read_own', 'Read one''s own eligible notifications');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE r."key" = 'owner';

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."key" IN ('orders.read', 'orders.create', 'orders.edit', 'orders.transition', 'orders.cancel_before_dispatch', 'orders.collect', 'catalog.read', 'catalog.write', 'catalog.publish', 'catalog.trash', 'media.upload', 'inventory.read', 'inventory.adjust', 'customers.read', 'notifications.read_own')
WHERE r."key" = 'staff';

-- Launch roles are fixed data (no custom-role builder): reject every UPDATE, for every role.
-- A later migration that must change a role drops and recreates this trigger deliberately.
CREATE FUNCTION "roles_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'roles are fixed launch data' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "roles_immutable" BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION "roles_immutable"();

-- Runtime role: permissions/grants are read-only; staff accounts are deactivated, never deleted.
-- roles keeps a single column-level UPDATE privilege: PostgreSQL requires UPDATE privilege for
-- SELECT ... FOR UPDATE, which the last-Owner guard takes on the seeded owner row (step 36).
-- The trigger above still rejects any actual UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "roles", "permissions", "role_permissions" FROM ih_app;
    GRANT UPDATE ("created_at") ON "roles" TO ih_app;
    REVOKE DELETE, TRUNCATE ON "staff_users" FROM ih_app;
    REVOKE TRUNCATE ON "sessions" FROM ih_app;
  END IF;
END;
$$;
