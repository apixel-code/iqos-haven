import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import {
  adminOrderResponseSchema,
  adminOrdersResponseSchema,
  errorEnvelopeSchema,
  orderEditResponseSchema,
  orderTransitionResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-admin-orders-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
});

let app: INestApplication;
let base = "";
let staffCookie = "";
let staffRoleId = "";
let staffId = "";
let first: Awaited<ReturnType<typeof seedOrder>>;
let second: Awaited<ReturnType<typeof seedOrder>>;
let lifecycle: Awaited<ReturnType<typeof seedOrder>>;

async function setStaffPermission(
  key: "orders.read" | "customers.read" | "orders.transition" | "orders.edit",
  enabled: boolean,
) {
  if (enabled)
    await pool.query(
      `INSERT INTO role_permissions (role_id,permission_id)
       SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING`,
      [staffRoleId, key],
    );
  else
    await pool.query(
      `DELETE FROM role_permissions rp USING permissions p
       WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2`,
      [staffRoleId, key],
    );
}
const call = (path: string, cookie = staffCookie) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    headers: { cookie, "x-ih-client-ip": "192.0.2.83" },
  });
const transition = (
  orderId: string,
  body: unknown,
  options: { cookie?: string; origin?: string } = {},
) =>
  fetch(`${base}/v1/admin/orders/${orderId}/transitions`, {
    method: "POST",
    headers: {
      cookie: options.cookie ?? staffCookie,
      origin: options.origin ?? ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": "192.0.2.84",
    },
    body: JSON.stringify(body),
  });
const edit = (orderId: string, body: unknown, options: { cookie?: string; origin?: string } = {}) =>
  fetch(`${base}/v1/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: {
      cookie: options.cookie ?? staffCookie,
      origin: options.origin ?? ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": "192.0.2.85",
    },
    body: JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;

async function makeEditableCommerceFixture(
  seeded: Awaited<ReturnType<typeof seedOrder>>,
  stock = 20,
) {
  await pool.query(
    `UPDATE brands SET active=true WHERE id=(SELECT p.brand_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    [seeded.variantId],
  );
  await pool.query(
    `UPDATE categories SET active=true WHERE id=(SELECT p.category_id FROM products p
       JOIN variants v ON v.product_id=p.id WHERE v.id=$1)`,
    [seeded.variantId],
  );
  await pool.query(
    "UPDATE products SET status='published' WHERE id=(SELECT product_id FROM variants WHERE id=$1)",
    [seeded.variantId],
  );
  await pool.query(
    "UPDATE delivery_areas SET active=true WHERE id=(SELECT area_id FROM orders WHERE id=$1)",
    [seeded.orderId],
  );
  await pool.query(
    `INSERT INTO stock_movements (variant_id,delta,balance_after,reason,command_id,effect,actor_id)
       VALUES ($1,$2,$2,'INITIAL_STOCK',$3,'adjust',$4)`,
    [seeded.variantId, stock, `edit-stock-${seeded.variantId}`, staffId],
  );
}

describe("admin order list and snapshot detail through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    staffRoleId = role.id;
    const staff = await db.staffUser.create({
      data: {
        email: "orders-reader@iqoshaven.test",
        name: "Order Reader",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    staffId = staff.id;
    first = await seedOrder(pool, { quantity: 2 });
    second = await seedOrder(pool, { status: "confirmed" });
    lifecycle = await seedOrder(pool);
    await db.customer.update({
      where: { id: first.customerId },
      data: { displayName: "Changed customer record" },
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: {
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": "192.0.2.82",
      },
      body: JSON.stringify({ email: staff.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    staffCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("requires a current orders.read grant and refuses invalid bounds and cursors", async () => {
    expect((await call("", "")).status).toBe(401);
    await setStaffPermission("orders.read", false);
    try {
      expect((await call("")).status).toBe(403);
    } finally {
      await setStaffPermission("orders.read", true);
    }
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?status=unknown",
      "?q=%20%20",
      "?after=abc",
      "?from=2026-10-13T12:00:00.000Z&to=2026-10-13T12:00:00.000Z",
      "?extra=yes",
    ])
      expect((await call(query)).status, query).toBe(400);
    expect((await call("/not-a-uuid")).status).toBe(400);
    expect((await call("/" + randomUUID())).status).toBe(404);
  });

  it("filters and keyset-pages newest-first within bounded dates", async () => {
    const firstPageResponse = await call("?limit=1");
    expect(firstPageResponse.status).toBe(200);
    expect(firstPageResponse.headers.get("cache-control")).toBe("private, no-store");
    const page = adminOrdersResponseSchema.parse(await firstPageResponse.json());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = adminOrdersResponseSchema.parse(
      await (await call("?limit=1&after=" + page.nextCursor)).json(),
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    const confirmed = adminOrdersResponseSchema.parse(
      await (
        await call("?status=confirmed&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z")
      ).json(),
    );
    expect(confirmed.items.map((item) => item.id)).toEqual([second.orderId]);
    expect(confirmed.items[0]).toMatchObject({ itemCount: 1, customer: { name: "Seed Customer" } });
  });

  it("lists only delayed open orders with the dashboard's rule (deep links, parity G-A2)", async () => {
    const late = await seedOrder(pool);
    const lateConfirmed = await seedOrder(pool, { status: "confirmed" });
    // Pending over 2 h is delayed; confirmed at 2.5 h is not yet (3 h).
    // Placement time is immutable; only this fixture steps around the guard trigger.
    await pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
    try {
      await pool.query(
        "UPDATE orders SET created_at=now() - interval '150 minutes' WHERE id=ANY($1)",
        [[late.orderId, lateConfirmed.orderId]],
      );
    } finally {
      await pool.query("ALTER TABLE orders ENABLE TRIGGER USER");
    }
    const response = await call("?delayed=true&limit=100");
    expect(response.status).toBe(200);
    const ids = adminOrdersResponseSchema.parse(await response.json()).items.map((item) => item.id);
    expect(ids).toContain(late.orderId);
    expect(ids).not.toContain(lateConfirmed.orderId);
    expect(ids).not.toContain(second.orderId);
    const confirmedOnly = adminOrdersResponseSchema.parse(
      await (await call("?delayed=true&status=confirmed")).json(),
    );
    expect(confirmedOnly.items.map((item) => item.id)).not.toContain(late.orderId);
    expect((await call("?delayed=yes")).status).toBe(400);
  });

  it("returns immutable customer, address, item, amount and append-only history snapshots", async () => {
    const byNumber = adminOrdersResponseSchema.parse(
      await (await call("?q=" + first.orderNumber)).json(),
    );
    expect(byNumber.items.map((item) => item.id)).toEqual([first.orderId]);
    const byCustomer = adminOrdersResponseSchema.parse(
      await (await call("?q=Seed%20Customer")).json(),
    );
    expect(byCustomer.items.map((item) => item.id)).toContain(first.orderId);
    const detailResponse = await call("/" + first.orderId);
    expect(detailResponse.status).toBe(200);
    const detail = adminOrderResponseSchema.parse(await detailResponse.json());
    expect(detail).toMatchObject({
      customer: {
        name: "Seed Customer",
        address: { building: "Seed Villa 1" },
      },
      merchandiseSubtotalFils: 10000,
      deliveryFeeFils: 1500,
      totalFils: 11500,
      items: [{ productName: "Seed product", quantity: 2, attributes: {} }],
      history: [{ fromStatus: null, toStatus: "pending", actorKind: "customer", orderVersion: 1 }],
    });
    expect(JSON.stringify(detail)).not.toContain("Changed customer record");
    for (const secret of [
      "customerId",
      "creationKeyHash",
      "quoteFingerprint",
      "confirmationHash",
      "commandId",
    ])
      expect(detail).not.toHaveProperty(secret);
  });

  it("strips contact and prevents contact-search inference without customers.read", async () => {
    await setStaffPermission("customers.read", false);
    try {
      const list = adminOrdersResponseSchema.parse(await (await call("?q=Seed%20Customer")).json());
      expect(list.items).toEqual([]);
      const number = adminOrdersResponseSchema.parse(
        await (await call("?q=" + first.orderNumber)).json(),
      );
      expect(number.items).toHaveLength(1);
      expect(number.items[0]).not.toHaveProperty("customer");
      const detail = adminOrderResponseSchema.parse(await (await call("/" + first.orderId)).json());
      expect(detail).not.toHaveProperty("customer");
      expect(JSON.stringify(detail)).not.toContain("Seed Customer");
      expect(JSON.stringify(detail)).not.toContain("Seed Villa 1");
    } finally {
      await setStaffPermission("customers.read", true);
    }
  });

  it("enforces permission, origin and the strict transition command contract", async () => {
    const body = { to: "confirmed", expectedVersion: 1, commandId: randomUUID() };
    expect((await transition(lifecycle.orderId, body, { cookie: "" })).status).toBe(401);
    expect(
      (await transition(lifecycle.orderId, body, { origin: "https://evil.example" })).status,
    ).toBe(403);
    await setStaffPermission("orders.transition", false);
    try {
      expect((await transition(lifecycle.orderId, body)).status).toBe(403);
    } finally {
      await setStaffPermission("orders.transition", true);
    }
    expect((await transition("not-a-uuid", body)).status).toBe(400);
    expect((await transition(lifecycle.orderId, { ...body, extra: true })).status).toBe(400);
    expect((await transition(lifecycle.orderId, { ...body, to: "cancelled" })).status).toBe(400);
  });

  it("rejects stale and forbidden moves without an effect", async () => {
    const before = await pool.query("SELECT version,status FROM orders WHERE id=$1", [
      lifecycle.orderId,
    ]);
    const stale = await transition(lifecycle.orderId, {
      to: "confirmed",
      expectedVersion: 9,
      commandId: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("VERSION_CONFLICT");
    const skipped = await transition(lifecycle.orderId, {
      to: "processing",
      expectedVersion: 1,
      commandId: randomUUID(),
    });
    expect(skipped.status).toBe(409);
    expect(await errorCode(skipped)).toBe("INVALID_TRANSITION");
    expect(
      (await pool.query("SELECT version,status FROM orders WHERE id=$1", [lifecycle.orderId])).rows,
    ).toEqual(before.rows);
  });

  it("runs the fulfilment state machine with replay-safe history, audit and events", async () => {
    const steps = ["confirmed", "processing", "out_for_delivery", "delivered"] as const;
    let version = 1;
    for (const to of steps) {
      const commandId = randomUUID();
      const body = { to, expectedVersion: version, commandId };
      const responses =
        version === 1
          ? await Promise.all(Array.from({ length: 5 }, () => transition(lifecycle.orderId, body)))
          : [await transition(lifecycle.orderId, body)];
      for (const response of responses) expect(response.status).toBe(200);
      const receipts = await Promise.all(
        responses.map(async (response) =>
          orderTransitionResponseSchema.parse(await response.json()),
        ),
      );
      const receipt = receipts.find((item) => !item.replayed)!;
      expect(receipts.filter((item) => !item.replayed)).toHaveLength(1);
      const response = responses[0]!;
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(receipt).toMatchObject({
        orderId: lifecycle.orderId,
        toStatus: to,
        orderVersion: version + 1,
        replayed: false,
        actor: { name: "Order Reader" },
      });
      const replay = orderTransitionResponseSchema.parse(
        await (await transition(lifecycle.orderId, body)).json(),
      );
      expect(replay).toEqual({ ...receipt, replayed: true });
      const changed = await transition(lifecycle.orderId, {
        ...body,
        to: to === "confirmed" ? "processing" : "confirmed",
      });
      expect(changed.status).toBe(409);
      expect(await errorCode(changed)).toBe("COMMAND_REUSED");
      if (version === 1) {
        const otherOrder = await transition(first.orderId, body);
        expect(otherOrder.status).toBe(409);
        expect(await errorCode(otherOrder)).toBe("COMMAND_REUSED");
      }
      version++;
    }
    const state = (
      await pool.query(
        `SELECT status,version,cod_status,dispatched_at,delivered_at FROM orders WHERE id=$1`,
        [lifecycle.orderId],
      )
    ).rows[0];
    expect(state).toMatchObject({ status: "delivered", version: 5, cod_status: "pending" });
    expect(state.dispatched_at).toBeInstanceOf(Date);
    expect(state.delivered_at).toBeInstanceOf(Date);
    expect(
      Number(
        (
          await pool.query("SELECT count(*) FROM order_status_history WHERE order_id=$1", [
            lifecycle.orderId,
          ])
        ).rows[0].count,
      ),
    ).toBe(5);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM audit_log WHERE entity_id=$1 AND action='order.status_changed'",
            [lifecycle.orderId],
          )
        ).rows[0].count,
      ),
    ).toBe(4);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.status_changed'",
            [lifecycle.orderId],
          )
        ).rows[0].count,
      ),
    ).toBe(4);
    const detail = adminOrderResponseSchema.parse(
      await (await call("/" + lifecycle.orderId)).json(),
    );
    expect(detail.history.map((entry) => entry.toStatus)).toEqual([
      "pending",
      "confirmed",
      "processing",
      "out_for_delivery",
      "delivered",
    ]);
  });

  it("edits merchandise, coupon, address and notes atomically with net stock and replay-safe diffs", async () => {
    const target = await seedOrder(pool, { quantity: 2 });
    const addition = await seedOrder(pool);
    await makeEditableCommerceFixture(target);
    await makeEditableCommerceFixture(addition);
    await db.setting.upsert({
      where: { key: "delivery" },
      create: {
        key: "delivery",
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
        updatedBy: staffId,
      },
      update: {
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
        updatedBy: staffId,
      },
    });
    await db.coupon.create({
      data: { code: "EDIT10", percentBps: 1000, active: true, updatedBy: staffId },
    });
    const commandId = randomUUID();
    const body = {
      expectedVersion: 1,
      commandId,
      lines: [
        { variantId: target.variantId, quantity: 3 },
        { variantId: addition.variantId, quantity: 1 },
      ],
      couponCode: "edit10",
      address: {
        areaId: (await pool.query("SELECT area_id FROM orders WHERE id=$1", [target.orderId]))
          .rows[0].area_id,
        type: "villa",
        building: "Seed Villa 2",
        unit: null,
        street: "Palm Street",
        makani: null,
        notes: "Back gate",
      },
      operationalNote: "Call on arrival",
    };
    const responses = await Promise.all([
      edit(target.orderId, body),
      edit(target.orderId, body),
      edit(target.orderId, body),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    const receipts = await Promise.all(
      responses.map(async (response) => orderEditResponseSchema.parse(await response.json())),
    );
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      orderId: target.orderId,
      orderVersion: 2,
      actor: { name: "Order Reader" },
      diff: {
        coupon: { before: null, after: "EDIT10" },
        delivery: { addressChanged: true },
        operationalNote: { before: null, after: "Call on arrival" },
      },
    });
    const state = (
      await pool.query(
        `SELECT version,total_fils::int,address_building,coupon_code FROM orders WHERE id=$1`,
        [target.orderId],
      )
    ).rows[0];
    expect(state).toEqual({
      version: 2,
      total_fils: 19500,
      address_building: "Seed Villa 2",
      coupon_code: "EDIT10",
    });
    expect(
      (
        await pool.query(
          `SELECT id AS variant_id,stock_on_hand FROM variants WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [[target.variantId, addition.variantId]],
        )
      ).rows.map((row) => [row.variant_id, row.stock_on_hand]),
    ).toEqual(
      [
        [target.variantId, 19],
        [addition.variantId, 19],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(
      Number(
        (
          await pool.query("SELECT count(*) FROM order_edit_history WHERE order_id=$1", [
            target.orderId,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);

    const removal = await edit(target.orderId, {
      expectedVersion: 2,
      commandId: randomUUID(),
      lines: [{ variantId: addition.variantId, quantity: 1 }],
      couponCode: null,
    });
    expect(removal.status).toBe(200);
    expect(orderEditResponseSchema.parse(await removal.json())).toMatchObject({
      orderVersion: 3,
      diff: { coupon: { before: "EDIT10", after: null } },
    });
    expect(
      (await pool.query("SELECT stock_on_hand FROM variants WHERE id=$1", [target.variantId]))
        .rows[0].stock_on_hand,
    ).toBe(22);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM coupon_redemptions WHERE order_id=$1 AND released_at IS NULL",
            [target.orderId],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    const detail = adminOrderResponseSchema.parse(await (await call("/" + target.orderId)).json());
    expect(detail).toMatchObject({
      version: 3,
      operationalNote: "Call on arrival",
      items: [{ variantId: addition.variantId, quantity: 1 }],
    });
    expect(detail.edits).toHaveLength(2);
  });

  it("allows only operational notes during processing and refuses stale or unauthorized edits", async () => {
    const target = await seedOrder(pool, { status: "confirmed" });
    const processing = await transition(target.orderId, {
      to: "processing",
      expectedVersion: 1,
      commandId: randomUUID(),
    });
    expect(processing.status).toBe(200);
    const stale = await edit(target.orderId, {
      expectedVersion: 1,
      commandId: randomUUID(),
      operationalNote: "stale",
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("VERSION_CONFLICT");
    const merchandise = await edit(target.orderId, {
      expectedVersion: 2,
      commandId: randomUUID(),
      lines: [{ variantId: target.variantId, quantity: 2 }],
    });
    expect(merchandise.status).toBe(409);
    expect(await errorCode(merchandise)).toBe("ORDER_NOT_EDITABLE");
    const note = await edit(target.orderId, {
      expectedVersion: 2,
      commandId: randomUUID(),
      operationalNote: "Pack separately",
    });
    expect(note.status, await note.clone().text()).toBe(200);
    expect(orderEditResponseSchema.parse(await note.json())).toMatchObject({
      orderVersion: 3,
      diff: { operationalNote: { before: null, after: "Pack separately" } },
    });
    await setStaffPermission("orders.edit", false);
    try {
      expect(
        (
          await edit(target.orderId, {
            expectedVersion: 3,
            commandId: randomUUID(),
            operationalNote: "Denied",
          })
        ).status,
      ).toBe(403);
    } finally {
      await setStaffPermission("orders.edit", true);
    }
  });

  it("rolls the order and history back when required audit cannot be written", async () => {
    const target = await seedOrder(pool);
    await pool.query(`CREATE FUNCTION reject_transition_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='order.status_changed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_transition_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_transition_audit()`);
    try {
      expect(
        (
          await transition(target.orderId, {
            to: "confirmed",
            expectedVersion: 1,
            commandId: randomUUID(),
          })
        ).status,
      ).toBe(500);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_transition_audit ON audit_log; DROP FUNCTION reject_transition_audit()",
      );
    }
    expect(
      (await pool.query("SELECT status,version FROM orders WHERE id=$1", [target.orderId])).rows[0],
    ).toEqual({ status: "pending", version: 1 });
    expect(
      Number(
        (
          await pool.query("SELECT count(*) FROM order_status_history WHERE order_id=$1", [
            target.orderId,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await pool.query("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1", [
            target.orderId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
  });
});
