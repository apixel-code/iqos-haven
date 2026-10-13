import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { ORDER_STATUSES, canTransition, formatOrderNumber } from "@ih/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { applyMigrations, seedOrder } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-orders-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const rejected = (sql: string, params: unknown[] = [], code = "23514") =>
  expect(pool.query(sql, params)).rejects.toMatchObject({ code });
/** Several statements in one transaction, so deferred checks run at its commit. */
async function atomically(statements: Array<[string, unknown[]]>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, params] of statements) await client.query(sql, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const EXTRA: Record<string, string> = {
  out_for_delivery: ", dispatched_at=statement_timestamp()",
  delivered: ", delivered_at=statement_timestamp()",
  cancelled:
    ", cancelled_at=statement_timestamp(), cancel_reason='Synthetic reason', cod_status='not_collected'",
};
/** A status change the way a command makes it: the order and its history row together. */
const move = (orderId: string, from: string, to: string, reason: string | null = null) =>
  atomically([
    [
      `UPDATE orders SET status=$2, version=version+1, updated_at=statement_timestamp()${EXTRA[to] ?? ""} WHERE id=$1`,
      [orderId, to],
    ],
    [
      `INSERT INTO order_status_history (order_id, from_status, to_status, reason, actor_kind, command_id, order_version)
       SELECT id, $2, $3, $4, 'system', $5, version FROM orders WHERE id=$1`,
      [
        orderId,
        from,
        to,
        to === "cancelled" ? (reason ?? "Synthetic reason") : reason,
        randomUUID(),
      ],
    ],
  ]);
const PATH = ["confirmed", "processing", "out_for_delivery", "delivered"] as const;
async function orderAt(status: (typeof ORDER_STATUSES)[number]) {
  const seeded = await seedOrder(pool);
  let current = "pending";
  if (status === "cancelled") await move(seeded.orderId, "pending", "cancelled");
  else
    for (const next of PATH.slice(0, PATH.indexOf(status as (typeof PATH)[number]) + 1)) {
      await move(seeded.orderId, current, next);
      current = next;
    }
  return seeded;
}
const row = (orderId: string) => db.order.findUniqueOrThrow({ where: { id: orderId } });

describe("orders, lines and status history (real PostgreSQL, isolated schema)", () => {
  let runtimeRole = false;
  beforeAll(async () => {
    runtimeRole =
      (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ih_app'")).rowCount === 1;
    if (process.env.CI) expect(runtimeRole).toBe(true);
    await applyMigrations(pool, namespace, runtimeRole ? { runtimeRole: "ih_app" } : {});
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("starts empty and numbers orders in sequence from 1001", async () => {
    for (const table of ["orders", "order_items", "order_status_history"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    const first = await seedOrder(pool);
    const second = await seedOrder(pool);
    expect(first.orderNumber).toBe(1001);
    expect(second.orderNumber).toBe(1002);
    expect(formatOrderNumber(first.orderNumber)).toBe("IH-001001");
    const created = await row(first.orderId);
    expect(created).toMatchObject({
      status: "pending",
      source: "storefront",
      codStatus: "pending",
      version: 1,
      merchandiseSubtotalFils: 5000n,
      deliveryFeeFils: 1500n,
      totalFils: 6500n,
    });
    expect(created.id.split("-")[2]![0]).toBe("7");
    // The number is the database's: it cannot be chosen or changed.
    await rejected("UPDATE orders SET order_number=7 WHERE id=$1", [first.orderId], "428C9");
    await rejected(
      "INSERT INTO orders (order_number, customer_id, source, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, creation_scope, creation_key_hash, creation_payload_hash) SELECT 7, customer_id, source, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, 'other', creation_key_hash, creation_payload_hash FROM orders WHERE id=$1",
      [first.orderId],
      "428C9",
    );
  });
  it("keeps its own copy: later edits of the customer, product, variant and area do not reach it", async () => {
    const seeded = await seedOrder(pool);
    const order = await row(seeded.orderId);
    const items = await db.orderItem.findMany({ where: { orderId: seeded.orderId } });
    await pool.query(
      "UPDATE customers SET display_name='Renamed Later', version=version+1 WHERE id=$1",
      [seeded.customerId],
    );
    await pool.query(
      "UPDATE products SET name='Renamed product', base_price_fils=99999, version=version+1 WHERE id=$1",
      [items[0]!.productId],
    );
    await pool.query(
      "UPDATE variants SET sku='RENAMED-SKU', price_override_fils=1, version=version+1 WHERE id=$1",
      [seeded.variantId],
    );
    await pool.query(
      "UPDATE delivery_areas SET name='Renamed area', version=version+1 WHERE id=$1",
      [order.areaId],
    );
    expect(await row(seeded.orderId)).toEqual(order);
    expect(await db.orderItem.findMany({ where: { orderId: seeded.orderId } })).toEqual(items);
    expect(items[0]).toMatchObject({
      productName: "Seed product",
      unitPriceFils: 5000n,
      quantity: 1,
      subtotalFils: 5000n,
      totalFils: 5000n,
    });
    // Nothing an order points at can be removed from under it.
    await rejected("DELETE FROM customers WHERE id=$1", [seeded.customerId], "23001");
    await rejected("DELETE FROM variants WHERE id=$1", [seeded.variantId], "23001");
    await rejected("DELETE FROM products WHERE id=$1", [items[0]!.productId], "23001");
    await rejected("DELETE FROM delivery_areas WHERE id=$1", [order.areaId], "23001");
  });
  it("allows exactly the six-state transitions, with a history row for each", async () => {
    // Every pair: the database agrees with the domain state machine.
    for (const from of ORDER_STATUSES) {
      const seeded = await orderAt(from);
      for (const to of ORDER_STATUSES) {
        if (to === from) continue;
        const attempt = move(seeded.orderId, from, to);
        if (canTransition(from, to)) {
          // Only one move per order: check it and stop.
          await attempt;
          expect((await row(seeded.orderId)).status).toBe(to);
          break;
        }
        await expect(attempt, `${from} → ${to}`).rejects.toMatchObject({ code: "23514" });
        expect((await row(seeded.orderId)).status).toBe(from);
      }
    }
    const delivered = await orderAt("delivered");
    const history = await db.orderStatusHistory.findMany({
      where: { orderId: delivered.orderId },
      orderBy: { seq: "asc" },
    });
    expect(history.map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
      [null, "pending"],
      ["pending", "confirmed"],
      ["confirmed", "processing"],
      ["processing", "out_for_delivery"],
      ["out_for_delivery", "delivered"],
    ]);
    expect(history.map((entry) => entry.orderVersion)).toEqual([1, 2, 3, 4, 5]);
    // Delivered does not mean paid.
    expect(await row(delivered.orderId)).toMatchObject({
      status: "delivered",
      codStatus: "pending",
    });
  });
  it("refuses a status change without its history, and history that does not continue", async () => {
    const { orderId } = await seedOrder(pool);
    // Status changed, no history row: refused when the transaction commits.
    await rejected("UPDATE orders SET status='confirmed', version=version+1 WHERE id=$1", [
      orderId,
    ]);
    // A history row that claims a status the order is not in.
    await rejected(
      "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'pending','confirmed','system',$2,2)",
      [orderId, randomUUID()],
    );
    // History must continue from the last row.
    await rejected(
      "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'confirmed','processing','system',$2,2)",
      [orderId, randomUUID()],
    );
    expect((await row(orderId)).status).toBe("pending");
    // The same command cannot record a change twice.
    const command = randomUUID();
    const confirm = (id: string): Array<[string, unknown[]]> => [
      ["UPDATE orders SET status='confirmed', version=version+1 WHERE id=$1", [orderId]],
      [
        "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'pending','confirmed','system',$2,2)",
        [orderId, id],
      ],
    ];
    await atomically(confirm(command));
    await expect(
      pool.query(
        "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'confirmed','processing','system',$2,3)",
        [orderId, command],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // The history of an order starts at its creation, never at a later status.
    const copy = (status: string, source: string, actor: string, scope: string) =>
      `INSERT INTO orders (customer_id, status, source, created_by, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, creation_scope, creation_key_hash, creation_payload_hash)
       SELECT customer_id, '${status}', '${source}', ${actor}, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, '${scope}', creation_key_hash, creation_payload_hash FROM orders WHERE id=$1 RETURNING id`;
    const item =
      "INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_slug, brand_name, category_name, sku, product_version, variant_version, unit_price_fils, quantity, subtotal_fils, total_fils) SELECT $1, product_id, variant_id, product_name, product_slug, brand_name, category_name, sku, 1, 1, 5000, 1, 5000, 5000 FROM order_items WHERE order_id=$2";
    const first = (to: string, version = 1) =>
      `INSERT INTO order_status_history (order_id, from_status, to_status, reason, actor_kind, command_id, order_version) VALUES ($1, NULL, '${to}', 'Synthetic reason', 'system', $2, ${version})`;
    const sneak = async (scope: string, after: string | null, to: string, version = 1) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const created = await client.query(copy("pending", "storefront", "NULL", scope), [orderId]);
        const id = created.rows[0].id as string;
        await client.query(item, [id, orderId]);
        if (after)
          await client.query(`UPDATE orders SET ${after}, version=version+1 WHERE id=$1`, [id]);
        await client.query(first(to, version), [id, randomUUID()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    // A store order cannot be slipped in as confirmed, cancelled or anything later.
    await expect(sneak("h1", "status='confirmed'", "confirmed", 2)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(sneak("h2", "status='confirmed'", "confirmed")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      sneak(
        "h3",
        "status='cancelled', cancelled_at=statement_timestamp(), cancel_reason='Synthetic reason', cod_status='not_collected'",
        "cancelled",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    for (const to of ["processing", "out_for_delivery", "delivered"])
      await expect(sneak("h4" + to, null, to)).rejects.toMatchObject({ code: "23514" });
    await sneak("h5", null, "pending");
    // A status is left once: a second way out of the same status is refused outright.
    const forked = await seedOrder(pool);
    await move(forked.orderId, "pending", "confirmed");
    await expect(
      pool.query(
        "INSERT INTO order_status_history (order_id, from_status, to_status, reason, actor_kind, command_id, order_version) VALUES ($1,'pending','cancelled','Synthetic reason','system',$2,2)",
        [forked.orderId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^23(505|514)$/) });
    // History is append-only, for everyone.
    await rejected(
      "UPDATE order_status_history SET reason='Edited' WHERE order_id=$1",
      [orderId],
      "42501",
    );
    await rejected("DELETE FROM order_status_history WHERE order_id=$1", [orderId], "42501");
    // Staff changes name the staff member; others do not.
    await rejected(
      "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'confirmed','processing','staff',$2,3)",
      [orderId, randomUUID()],
    );
  });
  it("needs a reason to cancel and closes the cash side", async () => {
    const { orderId } = await seedOrder(pool);
    await expect(
      atomically([
        [
          "UPDATE orders SET status='cancelled', version=version+1, cancelled_at=statement_timestamp(), cod_status='not_collected' WHERE id=$1",
          [orderId],
        ],
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      atomically([
        [
          "UPDATE orders SET status='cancelled', version=version+1, cancelled_at=statement_timestamp(), cancel_reason='Customer asked', cod_status='not_collected' WHERE id=$1",
          [orderId],
        ],
        [
          "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'pending','cancelled','system',$2,2)",
          [orderId, randomUUID()],
        ],
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    // Cancelled cash cannot stay "pending".
    await rejected(
      "UPDATE orders SET status='cancelled', version=version+1, cancelled_at=statement_timestamp(), cancel_reason='Customer asked' WHERE id=$1",
      [orderId],
    );
    await move(orderId, "pending", "cancelled", "Customer asked");
    expect(await row(orderId)).toMatchObject({
      status: "cancelled",
      cancelReason: "Synthetic reason",
      codStatus: "not_collected",
    });
    // Cancelled is final.
    for (const to of ["pending", "confirmed", "delivered"])
      await expect(move(orderId, "cancelled", to)).rejects.toMatchObject({ code: "23514" });
  });
  it("fixes what was ordered once processing starts", async () => {
    const early = await seedOrder(pool);
    // Pending: a controlled edit may change the address, and the lines with matching totals.
    await pool.query(
      "UPDATE orders SET address_building='Villa 9', version=version+1 WHERE id=$1",
      [early.orderId],
    );
    await atomically([
      [
        "UPDATE order_items SET quantity=2, subtotal_fils=10000, total_fils=10000 WHERE order_id=$1",
        [early.orderId],
      ],
      [
        "UPDATE orders SET merchandise_subtotal_fils=10000, total_fils=11500, version=version+1 WHERE id=$1",
        [early.orderId],
      ],
    ]);
    expect(await row(early.orderId)).toMatchObject({
      totalFils: 11500n,
      addressBuilding: "Villa 9",
    });
    const late = await orderAt("processing");
    for (const change of [
      "address_building='Elsewhere'",
      "customer_name='Someone Else'",
      "customer_phone_e164='+971500000009'",
      "delivery_fee_fils=0, total_fils=5000",
      "coupon_code='LATE10', coupon_percent_bps=1000",
      "area_name='Other area'",
      "quote_fingerprint=repeat('B', 43)",
    ])
      await rejected(`UPDATE orders SET ${change}, version=version+1 WHERE id=$1`, [late.orderId]);
    await rejected(
      "UPDATE order_items SET quantity=2, subtotal_fils=10000, total_fils=10000 WHERE order_id=$1",
      [late.orderId],
    );
    await rejected("DELETE FROM order_items WHERE order_id=$1", [late.orderId]);
    await rejected(
      "INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_slug, brand_name, category_name, sku, product_version, variant_version, unit_price_fils, quantity, subtotal_fils, total_fils) SELECT order_id, product_id, $2, product_name, product_slug, brand_name, category_name, 'OTHER', 1, 1, 100, 1, 100, 100 FROM order_items WHERE order_id=$1",
      [late.orderId, (await seedOrder(pool)).variantId],
    );
    // Identity never changes, at any stage.
    for (const change of [
      "customer_id=(SELECT id FROM customers WHERE id<>orders.customer_id LIMIT 1)",
      "source='manual'",
      "creation_scope='other'",
      "creation_key_hash=sha256('x'::bytea)",
      "age_policy_version='other'",
      "created_at=statement_timestamp()",
      "version=version-1",
    ])
      await expect(
        pool.query(
          `UPDATE orders SET ${change}${change.startsWith("version") ? "" : ", version=version+1"} WHERE id=$1`,
          [early.orderId],
        ),
        change,
      ).rejects.toMatchObject({ code: "23514" });
    // Any change is exactly one version step: unchanged, skipped or repeated versions are refused.
    for (const version of ["version", "version+2"])
      await rejected(
        `UPDATE orders SET address_street='Synthetic St', version=${version} WHERE id=$1`,
        [early.orderId],
      );
    // The update that starts processing cannot also change what was ordered.
    const confirmed = await orderAt("confirmed");
    await expect(
      atomically([
        [
          "UPDATE orders SET status='processing', address_building='Swapped', version=version+1 WHERE id=$1",
          [confirmed.orderId],
        ],
        [
          "INSERT INTO order_status_history (order_id, from_status, to_status, actor_kind, command_id, order_version) VALUES ($1,'confirmed','processing','system',$2,3)",
          [confirmed.orderId, randomUUID()],
        ],
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await row(confirmed.orderId)).addressBuilding).toBe("Seed Villa 1");
  });
  it("keeps the money consistent: the total is its parts and the order is its lines", async () => {
    const { orderId, variantId } = await seedOrder(pool, { quantity: 3 });
    expect(await row(orderId)).toMatchObject({
      merchandiseSubtotalFils: 15000n,
      totalFils: 16500n,
    });
    for (const change of [
      "total_fils=16499",
      "merchandise_subtotal_fils=15001, total_fils=16501",
      "discount_fils=100, total_fils=16400",
      "delivery_fee_fils=-1, total_fils=14999",
      "merchandise_subtotal_fils=0, total_fils=1500",
      "coupon_code='HALF', coupon_percent_bps=NULL",
      "coupon_code='save10', coupon_percent_bps=1000",
      "coupon_code='SAVE10', coupon_percent_bps=10001",
    ])
      await expect(
        pool.query(`UPDATE orders SET ${change}, version=version+1 WHERE id=$1`, [orderId]),
        change,
      ).rejects.toMatchObject({ code: "23514" });
    for (const change of [
      "subtotal_fils=14999",
      "total_fils=14999",
      "quantity=0",
      "unit_price_fils=0",
      "discount_fils=15001",
      "discount_fils=100",
      "quantity=2, subtotal_fils=10000, total_fils=10000",
    ])
      await expect(
        pool.query(`UPDATE order_items SET ${change} WHERE order_id=$1`, [orderId]),
        change,
      ).rejects.toMatchObject({ code: "23514" });
    // A discount is shared out exactly: order and lines change together or not at all.
    await atomically([
      ["UPDATE order_items SET discount_fils=1500, total_fils=13500 WHERE order_id=$1", [orderId]],
      [
        "UPDATE orders SET coupon_code='SAVE10', coupon_percent_bps=1000, discount_fils=1500, total_fils=15000, version=version+1 WHERE id=$1",
        [orderId],
      ],
    ]);
    expect(await row(orderId)).toMatchObject({ discountFils: 1500n, totalFils: 15000n });
    // One line per variant.
    await expect(
      pool.query(
        "INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_slug, brand_name, category_name, sku, product_version, variant_version, unit_price_fils, quantity, subtotal_fils, total_fils) SELECT order_id, product_id, variant_id, product_name, product_slug, brand_name, category_name, sku, 1, 1, 5000, 1, 5000, 5000 FROM order_items WHERE order_id=$1",
        [orderId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(variantId).toBeTruthy();
  });
  it("records cash only for a delivered order, by a named person, with an amount", async () => {
    const pending = await seedOrder(pool);
    const collect =
      "cod_status='collected', collected_amount_fils=6500, collected_at=statement_timestamp(), collected_by=(SELECT id FROM staff_users LIMIT 1)";
    await rejected(`UPDATE orders SET ${collect}, version=version+1 WHERE id=$1`, [
      pending.orderId,
    ]);
    const delivered = await orderAt("delivered");
    for (const partial of [
      "cod_status='collected'",
      "cod_status='collected', collected_amount_fils=6500",
      "cod_status='collected', collected_amount_fils=6500, collected_at=statement_timestamp()",
      "collected_amount_fils=6500",
      "collection_reference='R-1'",
      "cod_status='not_collected'",
      `${collect.replace("6500", "-1")}`,
    ])
      await expect(
        pool.query(`UPDATE orders SET ${partial}, version=version+1 WHERE id=$1`, [
          delivered.orderId,
        ]),
        partial,
      ).rejects.toMatchObject({ code: "23514" });
    await pool.query(`UPDATE orders SET ${collect}, version=version+1 WHERE id=$1`, [
      delivered.orderId,
    ]);
    expect(await row(delivered.orderId)).toMatchObject({
      status: "delivered",
      codStatus: "collected",
      collectedAmountFils: 6500n,
    });
    // What happened stays recorded: the cash record and the delivery time are written once.
    for (const rewrite of [
      "cod_status='pending', collected_amount_fils=NULL, collected_at=NULL, collected_by=NULL",
      "collected_amount_fils=1",
      "collected_at=statement_timestamp()+interval '1 day'",
      "collection_reference='R-2'",
      "delivered_at=statement_timestamp()+interval '1 day'",
      "dispatched_at=statement_timestamp()+interval '1 day'",
    ])
      await expect(
        pool.query(`UPDATE orders SET ${rewrite}, version=version+1 WHERE id=$1`, [
          delivered.orderId,
        ]),
        rewrite,
      ).rejects.toMatchObject({ code: "23514" });
    const cancelled = await orderAt("cancelled");
    for (const rewrite of [
      "cancel_reason='Rewritten'",
      "cancelled_at=statement_timestamp()+interval '1 day'",
    ])
      await rejected(`UPDATE orders SET ${rewrite}, version=version+1 WHERE id=$1`, [
        cancelled.orderId,
      ]);
    // A pending order cannot carry a dispatch time.
    await rejected(
      "UPDATE orders SET dispatched_at=statement_timestamp(), version=version+1 WHERE id=$1",
      [pending.orderId],
    );
    // A delivered order cannot be cancelled, collected or not.
    await expect(move(delivered.orderId, "delivered", "cancelled")).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("is never deleted, by anyone", async () => {
    const { orderId } = await seedOrder(pool);
    await rejected("DELETE FROM orders WHERE id=$1", [orderId], "42501");
    await rejected("DELETE FROM order_items WHERE order_id=$1", [orderId]);
    expect(await db.order.count({ where: { id: orderId } })).toBe(1);
    expect(await db.orderItem.count({ where: { orderId } })).toBe(1);
  });
  it("refuses an order that is not complete or not what its source allows", async () => {
    const seeded = await seedOrder(pool);
    const copy = (overrides: string, scope: string) =>
      `INSERT INTO orders (customer_id, status, source, created_by, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, creation_scope, creation_key_hash, creation_payload_hash)
       SELECT customer_id, ${overrides}, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, '${scope}', creation_key_hash, creation_payload_hash FROM orders WHERE id=$1`;
    // The store cannot create a confirmed order; a manual order names its operator.
    await rejected(copy("'confirmed', 'storefront', NULL", "s1"), [seeded.orderId]);
    await rejected(copy("'pending', 'manual', NULL", "s2"), [seeded.orderId]);
    await rejected(copy("'processing', 'manual', (SELECT id FROM staff_users LIMIT 1)", "s3"), [
      seeded.orderId,
    ]);
    await rejected(copy("'pending', 'phone', NULL", "s4"), [seeded.orderId]);
    // An order with no lines, or no history, cannot be committed.
    await rejected(copy("'pending', 'storefront', NULL", "s5"), [seeded.orderId]);
    // One order per creation key, for ever.
    await rejected(copy("'pending', 'storefront', NULL", "seed"), [seeded.orderId], "23505");
    for (const change of [
      "customer_phone_e164='0501234567'",
      "customer_name=' Padded'",
      "area_emirate='muscat'",
      "address_type='hotel'",
      "address_makani='12345'",
      "address_notes=''",
      "quote_fingerprint='short'",
      "delivery_eta_text=' '",
      "confirmation_hash=sha256('x'::bytea)",
      "confirmation_hash='\\x00'::bytea, confirmation_expires_at=statement_timestamp()",
    ])
      await expect(
        pool.query(`UPDATE orders SET ${change}, version=version+1 WHERE id=$1`, [seeded.orderId]),
        change,
      ).rejects.toMatchObject({ code: "23514" });
    // A confirmation verifier is unique across orders.
    const other = await seedOrder(pool);
    const verifier =
      "confirmation_hash=sha256('capability'::bytea), confirmation_expires_at=statement_timestamp()+interval '30 minutes'";
    await pool.query(`UPDATE orders SET ${verifier}, version=version+1 WHERE id=$1`, [
      seeded.orderId,
    ]);
    await rejected(
      `UPDATE orders SET ${verifier}, version=version+1 WHERE id=$1`,
      [other.orderId],
      "23505",
    );
  });
  it("lets the runtime role replace editable lines but never delete orders or rewrite history", async () => {
    if (!runtimeRole) return;
    const privilege = async (table: string, name: string) =>
      (
        await pool.query<{ ok: boolean }>(
          `SELECT has_table_privilege('ih_app', $1 || '.${table}', '${name}') AS ok`,
          [namespace],
        )
      ).rows[0]!.ok;
    for (const table of ["orders", "order_items", "order_status_history"]) {
      expect(await privilege(table, "SELECT")).toBe(true);
      expect(await privilege(table, "INSERT")).toBe(true);
      expect(await privilege(table, "DELETE")).toBe(table === "order_items");
      expect(await privilege(table, "TRUNCATE")).toBe(false);
    }
    expect(await privilege("orders", "UPDATE")).toBe(true);
    expect(await privilege("order_items", "UPDATE")).toBe(true);
    expect(await privilege("order_status_history", "UPDATE")).toBe(false);
    // The runtime role can create an order: the identity number needs no extra grant.
    const seeded = await seedOrder(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE ih_app");
      } catch (error) {
        if (process.env.CI) throw error;
        await client.query("ROLLBACK");
        return;
      }
      const table = (name: string) => `"${namespace}".${name}`;
      const inserted = await client.query(
        `INSERT INTO ${table("orders")} (customer_id, source, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, creation_scope, creation_key_hash, creation_payload_hash)
         SELECT customer_id, source, customer_name, customer_phone_e164, area_id, area_code, area_name, area_emirate, address_type, address_building, merchandise_subtotal_fils, delivery_fee_fils, total_fils, delivery_eta_text, area_version, delivery_configuration_version, quote_fingerprint, age_confirmed_at, age_policy_version, 'runtime', creation_key_hash, creation_payload_hash FROM ${table("orders")} WHERE id=$1 RETURNING id, order_number`,
        [seeded.orderId],
      );
      expect(Number(inserted.rows[0].order_number)).toBeGreaterThan(seeded.orderNumber);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
