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
  adminCustomerResponseSchema,
  adminCustomersResponseSchema,
  manualOrderResponseSchema,
  orderWhatsappResponseSchema,
  storeQuoteResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
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
  applicationName: "ih-admin-customers-test",
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
let owner = "";
let staff = "";
let ownerId = "";
let staffRoleId = "";
let host = 10;

const send = (
  path: string,
  method: string,
  body: unknown,
  cookie: string,
  extra: Record<string, string> = {},
) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin: ADMIN,
      "content-type": "application/json",
      // Each call from its own address keeps the per-address limiter out of the way.
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
      ...extra,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[]) =>
  Number((await one<{ n: string }>(sql, params)).n);

let areaId = "";
let serial = 0;
const key = () => "m" + randomUUID().replaceAll("-", "");
async function variant(priceFils: bigint, stock: number) {
  const brand = await db.brand.create({
    data: { name: "Desk brand " + key(), slug: key(), active: true },
  });
  const category = await db.category.create({
    data: { name: "Desk category " + key(), slug: key(), active: true },
  });
  const product = await db.product.create({
    data: {
      name: "Desk Kit",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils: priceFils,
      status: "published",
    },
  });
  const row = await db.variant.create({
    data: {
      productId: product.id,
      sku: key().slice(0, 20).toUpperCase(),
      active: true,
      isDefault: true,
    },
  });
  await pool.query(
    "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
    [row.id, stock, randomUUID()],
  );
  return { id: row.id, productId: product.id };
}
const setPermission = async (key: string, enabled: boolean) =>
  pool.query(
    enabled
      ? "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING"
      : "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2",
    [staffRoleId, key],
  );

describe("admin customers and order WhatsApp links through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "People Owner" : "People Staff",
          roleId: role.id,
          passwordHash: await hasher.hash(PASSWORD),
        },
      });
      const response = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: {
          origin: ADMIN,
          "content-type": "application/json",
          "x-ih-client-ip": "192.0.2.250",
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(response.status).toBe(200);
      return {
        id: user.id,
        roleId: role.id,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const o = await login("owner", "people-owner@iqoshaven.test");
    const s = await login("staff", "people-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
    areaId = (
      await db.deliveryArea.create({
        data: {
          code: "desk_area",
          name: "Desk Area",
          emirate: "dubai",
          active: true,
          updatedBy: ownerId,
        },
      })
    ).id;
    await db.setting.create({
      data: {
        key: "delivery",
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
        updatedBy: ownerId,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  /** What the order desk does: price the order, then create it with that total's token. */
  async function manual(
    lines: Array<{ variantId: string; quantity: number }>,
    extra: Record<string, unknown> = {},
    cookie = staff,
  ) {
    const priced = await send("/quote", "POST", { lines, areaId, couponCode: null }, cookie);
    expect(priced.status).toBe(200);
    const quote = storeQuoteResponseSchema.parse(await priced.json());
    return {
      quote,
      body: {
        contact: { name: "Desk Customer", phone: "050 640 " + String(++serial).padStart(4, "0") },
        address: { areaId, type: "villa", building: "Desk Villa 3" },
        lines,
        couponCode: null,
        quoteToken: quote.quote.token,
        ageConfirmed: true,
        start: "pending",
        ...extra,
      },
    };
  }
  const create = (body: unknown, attempt: string | null = key(), cookie = staff) =>
    send("", "POST", body, cookie, attempt === null ? {} : { "idempotency-key": attempt });

  /** Places a manual order for a given phone and returns its ID. */
  async function orderFor(phone: string, name: string, quantity = 1) {
    const item = await variant(4000n, 20);
    const { body } = await manual([{ variantId: item.id, quantity }], {}, owner);
    const response = await create({ ...body, contact: { name, phone } }, key(), owner);
    expect(response.status).toBe(201);
    return manualOrderResponseSchema.parse(await response.json()).orderId;
  }
  const moveTo = async (orderId: string, targets: string[]) => {
    for (const to of targets) {
      const { version } = await one<{ version: number }>("SELECT version FROM orders WHERE id=$1", [
        orderId,
      ]);
      expect(
        (
          await send(
            `/${orderId}/transitions`,
            "POST",
            { to, expectedVersion: version, commandId: randomUUID() },
            owner,
          )
        ).status,
      ).toBe(200);
    }
  };
  const customers = (query: string, cookie = staff) =>
    fetch(`${base}/v1/admin/customers${query}`, {
      headers: { cookie, "x-ih-client-ip": "192.0.2.201" },
    });

  it("lists customers who ordered, with spend only for the Owner", async () => {
    // Three orders for one phone: AED 55.00 delivered, AED 95.00 open, AED 55.00 cancelled.
    const delivered = await orderFor("050 650 0001", "Repeat Buyer");
    await orderFor("050 650 0001", "Repeat Buyer", 2);
    const cancelled = await orderFor("050 650 0001", "Repeat Buyer");
    await moveTo(delivered, ["confirmed", "processing", "out_for_delivery", "delivered"]);
    expect(
      (
        await send(
          `/${cancelled}/cancel`,
          "POST",
          { expectedVersion: 1, commandId: randomUUID(), reason: "Test" },
          owner,
        )
      ).status,
    ).toBe(200);
    await orderFor("050 650 0002", "Other Buyer");
    // A customer row without any order is not listed.
    await db.customer.create({
      data: { phoneE164: "+971506500009", displayName: "Never Ordered" },
    });

    const asStaff = adminCustomersResponseSchema.parse(await (await customers("?q=Repeat")).json());
    expect(asStaff.items).toHaveLength(1);
    expect(asStaff.items[0]).toMatchObject({
      name: "Repeat Buyer",
      phone: "+971506500001",
      orderCount: 3,
      areaName: "Desk Area",
    });
    expect(asStaff.items[0]).not.toHaveProperty("spend");
    const asOwner = adminCustomersResponseSchema.parse(
      await (await customers("?q=Repeat", owner)).json(),
    );
    expect(asOwner.items[0]!.spend).toEqual({ bookedFils: 5500 + 9500, deliveredFils: 5500 });
    // Search by phone digits, typed as staff would; too few digits do not match a phone.
    const byPhone = adminCustomersResponseSchema.parse(
      await (await customers("?q=050%20650%200002")).json(),
    );
    expect(byPhone.items.map((item) => item.name)).toEqual(["Other Buyer"]);
    const short = adminCustomersResponseSchema.parse(await (await customers("?q=65")).json());
    expect(short.items).toEqual([]);
    const all = adminCustomersResponseSchema.parse(await (await customers("")).json());
    expect(all.items.map((item) => item.name)).not.toContain("Never Ordered");
    // Keyset pages, newest customer first.
    const first = adminCustomersResponseSchema.parse(await (await customers("?limit=1")).json());
    const second = adminCustomersResponseSchema.parse(
      await (await customers(`?limit=1&after=${first.nextCursor}`)).json(),
    );
    expect(first.items[0]!.name).toBe("Other Buyer");
    expect(second.items[0]!.name).toBe("Repeat Buyer");
    expect((await customers("?after=not-a-cursor")).status).toBe(400);
    // Wildcards are searched for as typed, not as patterns.
    const wild = adminCustomersResponseSchema.parse(await (await customers("?q=%25")).json());
    expect(wild.items).toEqual([]);
    expect((await customers("?limit=500")).status).toBe(400);
  });

  it("shows one customer's addresses and orders, and spend only to the Owner", async () => {
    const orderId = await orderFor("050 650 0003", "Detail Buyer");
    await orderFor("050 650 0003", "Detail Buyer");
    const { customer_id: id } = await one<{ customer_id: string }>(
      "SELECT customer_id FROM orders WHERE id=$1",
      [orderId],
    );
    const response = await customers(`/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const shown = adminCustomerResponseSchema.parse(await response.json());
    expect(shown).toMatchObject({ name: "Detail Buyer", orderCount: 2, cancelledCount: 0 });
    expect(shown.orders).toHaveLength(2);
    expect(shown.orders[1]!.id).toBe(orderId);
    expect(shown.addresses[0]).toMatchObject({
      areaName: "Desk Area",
      type: "villa",
      building: "Desk Villa 3",
    });
    expect(shown).not.toHaveProperty("spend");
    const owned = adminCustomerResponseSchema.parse(
      await (await customers(`/${id}`, owner)).json(),
    );
    expect(owned.spend).toEqual({ bookedFils: 11000, deliveredFils: 0 });
    // Without the order permission the history is left out; without customers.read nothing.
    await setPermission("orders.read", false);
    try {
      expect(
        adminCustomerResponseSchema.parse(await (await customers(`/${id}`)).json()).orders,
      ).toEqual([]);
    } finally {
      await setPermission("orders.read", true);
    }
    await setPermission("customers.read", false);
    try {
      expect((await customers(`/${id}`)).status).toBe(403);
      expect((await customers("")).status).toBe(403);
    } finally {
      await setPermission("customers.read", true);
    }
    expect((await customers(`/${randomUUID()}`)).status).toBe(404);
  });

  it("gives ready WhatsApp messages for an order and records nothing", async () => {
    const orderId = await orderFor("050 650 0004", "Message Buyer");
    const number = (
      await one<{ n: string }>("SELECT order_number::text AS n FROM orders WHERE id=$1", [orderId])
    ).n;
    const label = `IH-${number.padStart(6, "0")}`;
    const before = await count("SELECT count(*) AS n FROM audit_log", []);
    const events = await count("SELECT count(*) AS n FROM outbox_events", []);
    const links = (cookie = staff) =>
      fetch(`${base}/v1/admin/orders/${orderId}/whatsapp?v=1`, {
        headers: { cookie, "x-ih-client-ip": "192.0.2.202" },
      });
    const placeholder = orderWhatsappResponseSchema.parse(await (await links()).json());
    expect(placeholder.phone).toBe("+971506500004");
    expect(placeholder.links.map((link) => [link.kind, link.placeholder])).toEqual([
      ["orderConfirmation", true],
      ["statusUpdate", true],
    ]);
    expect(placeholder.links[0]!.text).toBe(
      `Hi, this is Iqos Haven. We received your order ${label} for AED 55.00, cash on delivery. Please reply YES to confirm delivery.`,
    );
    expect(placeholder.links[0]!.href).toBe(
      `https://wa.me/971506500004?text=${encodeURIComponent(placeholder.links[0]!.text)}`,
    );
    expect(placeholder.links[1]!.text).toContain("is now: received");
    // The Owner's own wording, once set, replaces the placeholder.
    await db.setting.create({
      data: {
        key: "whatsapp",
        updatedBy: ownerId,
        value: {
          number: "+971500000001",
          templates: {
            orderConfirmation:
              "{{store_name}}: order {{order_number}}, {{total}}. Questions: {{support_phone}}",
            statusUpdate: null,
            support: null,
          },
        },
      },
    });
    const own = orderWhatsappResponseSchema.parse(await (await links()).json());
    expect(own.links[0]).toMatchObject({
      placeholder: false,
      text: `Iqos Haven: order ${label}, AED 55.00. Questions: +971500000001`,
    });
    expect(own.links[1]!.placeholder).toBe(true);
    // Reading the links wrote nothing.
    expect(await count("SELECT count(*) AS n FROM audit_log", [])).toBe(before);
    expect(await count("SELECT count(*) AS n FROM outbox_events", [])).toBe(events);
    await setPermission("customers.read", false);
    try {
      expect((await links()).status).toBe(403);
    } finally {
      await setPermission("customers.read", true);
    }
  });
});
