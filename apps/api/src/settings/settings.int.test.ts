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
  createDatabase,
  createPool,
  writeSetting,
  readSettings,
  SettingsForbiddenError,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import { type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-settings-test",
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
let base: string;
let seq = 0;
async function user(active = true, roleKey = "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `staff${seq++}@iqoshaven.test`,
      name: "Test Person",
      roleId: role.id,
      active,
      passwordHash: await hasher.hash(PASSWORD),
    },
  });
}
const post = (path: string, body: unknown, ip = "198.51.100.1", origin = ADMIN, root = base) =>
  fetch(`${root}/v1/auth/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-ih-client-ip": ip },
    body: JSON.stringify(body),
  });
let ownerCookie: string;
let ownerId: string;
let staffCookie: string;
async function login(email: string, root = base) {
  const r = await post("login", { email, password: PASSWORD }, "192.0.2.1", ADMIN, root);
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (path: string, method = "GET", body?: unknown, cookie = ownerCookie, root = base) =>
  fetch(`${root}/v1/admin/settings${path}`, {
    method,
    headers: {
      cookie,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
      "x-ih-client-ip": "192.0.2.2",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const store = { name: "Approved Test Store", domain: "store.example.test", legalName: null };
const contact = {
  email: "support@example.test",
  phone: "+971500000001",
  address: "Test address",
  openingHours: "Test hours",
  footerNote: null,
  social: { instagram: "https://instagram.com/test", tiktok: null, facebook: null },
};
const whatsapp = {
  number: "+971500000001",
  templates: {
    orderConfirmation: "{{store_name}}: order {{order_number}} total {{total}}",
    statusUpdate: "Order {{order_number}}: {{status}}",
    support: null,
  },
};
const notifications = {
  inApp: true,
  newOrderEmail: { enabled: true, recipients: ["notify@example.test"] },
};
describe("versioned settings through real API/PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user(true, "owner");
    ownerId = owner.id;
    const staff = await user();
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    ownerCookie = await login(owner.email);
    staffCookie = await login(staff.email);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("lists explicit unconfigured values without defaults; Owner only and strict queries", async () => {
    const r = await call("");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as {
      items: Array<{ key: string; value: unknown; version: number }>;
    };
    expect(body.items.map((x) => x.key)).toEqual(["store", "contact", "notifications", "whatsapp"]);
    for (const item of body.items) expect(item).toMatchObject({ value: null, version: 0 });
    expect(await db.setting.count()).toBe(0);
    expect((await call("", "GET", undefined, staffCookie)).status).toBe(403);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("?unsafe=true")).status).toBe(400);
    expect(
      (await call("", "PATCH", { key: "store", version: 0, value: store }, staffCookie)).status,
    ).toBe(403);
    expect((await call("", "PATCH", { key: "store", version: 0, value: store }, "")).status).toBe(
      401,
    );
  });
  it("rejects malformed/unbounded settings, arbitrary keys, nested fields and unsupported template placeholders", async () => {
    const invalid = [
      { key: "store", version: 0, value: { ...store, name: "   " } },
      { key: "store", version: 0, value: { ...store, domain: "https://store.example.test/path" } },
      { key: "store", version: 0, value: { ...store, secret: "never" } },
      { key: "contact", version: 0, value: { ...contact, phone: "050 1234" } },
      {
        key: "contact",
        version: 0,
        value: { ...contact, social: { ...contact.social, instagram: "javascript:alert(1)" } },
      },
      {
        key: "contact",
        version: 0,
        value: {
          ...contact,
          social: { ...contact.social, instagram: "https://user:pass@example.test" },
        },
      },
      {
        key: "notifications",
        version: 0,
        value: { inApp: true, newOrderEmail: { enabled: true, recipients: [] } },
      },
      {
        key: "notifications",
        version: 0,
        value: {
          inApp: true,
          newOrderEmail: { enabled: false, recipients: Array(11).fill("notify@example.test") },
        },
      },
      {
        key: "notifications",
        version: 0,
        value: {
          inApp: true,
          newOrderEmail: { enabled: true, recipients: ["a@example.test", "A@example.test"] },
        },
      },
      { key: "notifications", version: 0, value: { ...notifications, dailySummary: true } },
      // Low-stock email shares the recipient list, so it needs one.
      {
        key: "notifications",
        version: 0,
        value: {
          inApp: true,
          newOrderEmail: { enabled: false, recipients: [] },
          lowStockEmail: true,
        },
      },
      {
        key: "whatsapp",
        version: 0,
        value: { ...whatsapp, templates: { ...whatsapp.templates, support: "{{password}}" } },
      },
      {
        key: "whatsapp",
        version: 0,
        value: { ...whatsapp, templates: { ...whatsapp.templates, support: "{" } },
      },
      { key: "tax", version: 0, value: {} },
      { key: "store", version: -1, value: store },
      { key: "store", version: 0.5, value: store },
      { key: "store", version: 0, value: store, versionOverride: 1 },
    ];
    for (const body of invalid) expect((await call("", "PATCH", body)).status).toBe(400);
    expect(await db.setting.count()).toBe(0);
  });
  it("serializes concurrent first creation with one expected-version winner and atomic IDs-only effects", async () => {
    const results = await Promise.all([
      call("", "PATCH", { key: "store", version: 0, value: store }),
      call("", "PATCH", {
        key: "store",
        version: 0,
        value: { ...store, name: "Other Test Store" },
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await db.setting.findUniqueOrThrow({ where: { key: "store" } });
    expect(row.version).toBe(1);
    expect(row.updatedBy).toBe(ownerId);
    expect(
      await db.auditLog.count({ where: { entityId: "store", action: "settings.updated" } }),
    ).toBe(1);
    const events = await db.outboxEvent.findMany({
      where: { aggregateId: "store", eventType: "settings.updated" },
      include: { effects: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ key: "store" });
    expect(events[0]!.effects).toHaveLength(0);
    expect((await call("", "PATCH", { key: "store", version: 0, value: store })).status).toBe(409);
    expect((await call("", "PATCH", { key: "store", version: 1, value: row.value })).status).toBe(
      200,
    );
    const noop = await db.setting.findUniqueOrThrow({ where: { key: "store" } });
    expect(noop.updatedAt).toEqual(row.updatedAt);
    expect(noop.version).toBe(1);
    expect(
      await db.auditLog.count({ where: { entityId: "store", action: "settings.updated" } }),
    ).toBe(1);
  });
  it("rolls back missing-row sentinels, mutations and audit/outbox on conflicts or audit failure", async () => {
    const context = { actorId: ownerId, requestId: "" };
    await expect(
      writeSetting(db, context, { key: "notifications", version: 0, value: notifications }),
    ).rejects.toThrow();
    expect(await db.setting.findUnique({ where: { key: "notifications" } })).toBeNull();
    await expect(
      writeSetting(db, context, {
        key: "store",
        version: 1,
        value: { ...store, name: "Rollback Name" },
      }),
    ).rejects.toThrow();
    expect((await db.setting.findUniqueOrThrow({ where: { key: "store" } })).version).toBe(1);
    expect((await call("", "PATCH", { key: "whatsapp", version: 5, value: whatsapp })).status).toBe(
      409,
    );
    expect(await db.setting.findUnique({ where: { key: "whatsapp" } })).toBeNull();
  });
  it("saves all typed groups, never audits contact/recipient/template values and clears without deleting history", async () => {
    for (const body of [
      { key: "contact", version: 0, value: contact },
      { key: "notifications", version: 0, value: notifications },
      { key: "whatsapp", version: 0, value: whatsapp },
    ])
      expect((await call("", "PATCH", body)).status).toBe(200);
    const read = await readSettings(db, ownerId);
    expect(read.items).toHaveLength(4);
    expect(read.items.find((x) => x.key === "contact")?.value).toEqual(contact);
    const audit = await db.auditLog.findMany({ where: { action: "settings.updated" } });
    const serialized = JSON.stringify(audit);
    for (const value of [
      contact.email,
      contact.phone,
      contact.address,
      notifications.newOrderEmail.recipients[0],
      whatsapp.templates.orderConfirmation,
    ])
      expect(serialized).not.toContain(value);
    expect((await call("", "PATCH", { key: "contact", version: 1, value: null })).status).toBe(200);
    expect(await db.setting.findUnique({ where: { key: "contact" } })).toMatchObject({
      value: null,
      version: 2,
    });
    expect(await db.setting.count()).toBe(4);
  });
  it("enforces real DB key/version/value/FK constraints and immutable aggregate keys", async () => {
    for (const [key, value, version, actor] of [
      ["unknown", {}, 1, ownerId],
      ["store", [], 1, ownerId],
      ["store", {}, 0, ownerId],
      ["store", {}, 1, randomUUID()],
    ] as const) {
      // Existing-key upsert reaches UPDATE checks/FK without hiding them behind primary-key conflicts.
      await expect(
        pool.query(
          "INSERT INTO settings (key,value,version,updated_by) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by",
          [key, JSON.stringify(value), version, actor],
        ),
      ).rejects.toThrow();
    }
    await expect(
      pool.query("UPDATE settings SET key='contact' WHERE key='store'"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rechecks current authority after waiting on the Owner guard and denies direct repository Staff writes/reads", async () => {
    const actor = await user(true, "owner");
    const row = await db.setting.findUniqueOrThrow({ where: { key: "store" } });
    const holder = await pool.connect();
    let pending: ReturnType<typeof writeSetting> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM roles WHERE key='owner' FOR UPDATE");
      pending = writeSetting(
        db,
        { actorId: actor.id, requestId: randomUUID() },
        { key: "store", version: row.version, value: { ...store, name: "Stale Authority" } },
      );
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='ih-settings-test' AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM roles%'",
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query(
        "UPDATE staff_users SET role_id=(SELECT id FROM roles WHERE key='staff'),version=version+1 WHERE id=$1",
        [actor.id],
      );
      await holder.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(SettingsForbiddenError);
      expect((await db.setting.findUniqueOrThrow({ where: { key: "store" } })).version).toBe(
        row.version,
      );
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending?.catch(() => {});
    }
    await expect(readSettings(db, actor.id)).rejects.toBeInstanceOf(SettingsForbiddenError);
    await expect(
      writeSetting(
        db,
        { actorId: actor.id, requestId: randomUUID() },
        { key: "store", version: row.version, value: store },
      ),
    ).rejects.toBeInstanceOf(SettingsForbiddenError);
  });
  it("fails closed on the shared write limiter without changing configuration", async () => {
    const other = await createApp(
      {
        ...env,
        RATE_LIMIT_PROFILE: "replicated",
        CACHE_REDIS_URL: "redis://127.0.0.1:1",
        RATE_LIMIT_KEY_SECRET: "s".repeat(32),
      },
      { pool, database: db },
    );
    await other.listen(0, "127.0.0.1");
    try {
      expect(
        (
          await call(
            "",
            "PATCH",
            { key: "store", version: 1, value: store },
            ownerCookie,
            await other.getUrl(),
          )
        ).status,
      ).toBe(503);
    } finally {
      await other.close();
    }
  });
});
