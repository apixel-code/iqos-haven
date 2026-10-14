import { randomInt, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

/**
 * Integration tests only (exported as `@ih/db/testing`; ESLint forbids it elsewhere): applies every reviewed migration,
 * in order, into an isolated schema so tests exercise the real SQL, triggers and constraints.
 * `namespace` must be generated internally, never derived from input.
 */
export async function applyMigrations(
  pool: Pool,
  namespace: string,
  options: { runtimeRole?: string } = {},
): Promise<void> {
  if (!/^ih_test_[a-f0-9]{32}$/.test(namespace)) throw new Error("Unexpected test schema name");
  const folder = join(__dirname, "..", "prisma", "migrations");
  const migrations = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA "' + namespace + '"');
    await client.query('SET search_path TO "' + namespace + '"');
    // Mirror production: the runtime role receives default table privileges when migrations
    // create tables, so each migration's REVOKE/GRANT statements are exercised for real.
    if (options.runtimeRole === "ih_app")
      await client.query(
        'GRANT USAGE ON SCHEMA "' +
          namespace +
          '" TO ih_app; ' +
          'ALTER DEFAULT PRIVILEGES IN SCHEMA "' +
          namespace +
          '" ' +
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ih_app",
      );
    for (const name of migrations)
      await client.query(readFileSync(join(folder, name, "migration.sql"), "utf8"));
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
}

/**
 * Integration tests only: one committed, valid order with its own customer, area, product,
 * variant, line and history row, for tests that need an order to point at (coupon redemptions,
 * later stock movements). AED 50.00 of merchandise, AED 15.00 delivery, no coupon. Its area is
 * inactive and its product a draft, so the fixture never shows up in store answers.
 */
export async function seedOrder(
  pool: Pool,
  options: { status?: "pending" | "confirmed"; quantity?: number } = {},
): Promise<{ orderId: string; orderNumber: number; customerId: string; variantId: string }> {
  const client = await pool.connect();
  const tag = randomUUID().replaceAll("-", "").slice(0, 20);
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows[0] as T;
  const quantity = options.quantity ?? 1;
  const status = options.status ?? "pending";
  try {
    await client.query("BEGIN");
    const staff = await one<{ id: string }>(
      `INSERT INTO staff_users (email, name, role_id, password_hash)
       SELECT $1, 'Order Seeder', id, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'
       FROM roles WHERE key='owner' RETURNING id`,
      [`seed-${tag}@iqoshaven.test`],
    );
    const area = await one<{ id: string }>(
      `INSERT INTO delivery_areas (code, name, emirate, active, updated_by)
       VALUES ($1, $2, 'dubai', false, $3) RETURNING id`,
      ["seed_" + tag, "Seed area " + tag, staff.id],
    );
    const customer = await one<{ id: string }>(
      `INSERT INTO customers (phone_e164, display_name) VALUES ($1, 'Seed Customer') RETURNING id`,
      ["+9715" + String(randomInt(0, 100_000_000)).padStart(8, "0")],
    );
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Seed brand " + tag, "seed-brand-" + tag],
    );
    const category = await one<{ id: string }>(
      `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Seed category " + tag, "seed-category-" + tag],
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (name, slug, brand_id, category_id, type, base_price_fils)
       VALUES ('Seed product', $1, $2, $3, 'kit', 5000) RETURNING id`,
      ["seed-product-" + tag, brand.id, category.id],
    );
    const variant = await one<{ id: string }>(
      `INSERT INTO variants (product_id, sku, active, is_default) VALUES ($1, $2, true, true)
       RETURNING id`,
      [product.id, "SEED-" + tag.toUpperCase()],
    );
    const subtotal = 5000 * quantity;
    const order = await one<{ id: string; order_number: string }>(
      `INSERT INTO orders (customer_id, status, source, created_by, customer_name,
         customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type,
         address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils,
         delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint,
         age_confirmed_at, age_policy_version, creation_scope, creation_key_hash,
         creation_payload_hash)
       SELECT $1::uuid, $2::text, $3::text, $4::uuid, 'Seed Customer', c.phone_e164, $5::uuid, a.code,
         a.name, a.emirate, 'villa',
         'Seed Villa 1', $6::bigint, 1500, $6::bigint + 1500, 'Seed ETA', 1, 1, repeat('A', 43),
         statement_timestamp(), 'seed-policy', 'seed', sha256(convert_to($7::text, 'UTF8')),
         sha256(convert_to('payload-' || $7::text, 'UTF8'))
       FROM customers c, delivery_areas a WHERE c.id=$1::uuid AND a.id=$5::uuid
       RETURNING id, order_number`,
      [
        customer.id,
        status,
        status === "confirmed" ? "manual" : "storefront",
        status === "confirmed" ? staff.id : null,
        area.id,
        subtotal,
        tag,
      ],
    );
    await client.query(
      `INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_slug,
         brand_name, category_name, sku, product_version, variant_version, unit_price_fils,
         quantity, subtotal_fils, total_fils)
       VALUES ($1, $2, $3, 'Seed product', $4, 'Seed brand', 'Seed category', $5, 1, 1, 5000,
         $6::int, $7::bigint, $7::bigint)`,
      [
        order.id,
        product.id,
        variant.id,
        "seed-product-" + tag,
        "SEED-" + tag.toUpperCase(),
        quantity,
        subtotal,
      ],
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, reason, actor_kind,
         actor_id, command_id, order_version)
       VALUES ($1, NULL, $2::text, CASE WHEN $2::text = 'confirmed' THEN 'Seed confirmation evidence' END,
         $3, $4, $5, 1)`,
      [
        order.id,
        status,
        status === "confirmed" ? "staff" : "customer",
        status === "confirmed" ? staff.id : null,
        "create-" + tag,
      ],
    );
    await client.query("COMMIT");
    return {
      orderId: order.id,
      orderNumber: Number(order.order_number),
      customerId: customer.id,
      variantId: variant.id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
