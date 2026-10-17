import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { inboxResponseSchema, notificationReadResponseSchema } from "@ih/contracts";
import { changeStaffRole, createDatabase, createPool, deactivateStaff } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { EVENT_STREAM } from "./admin-events.controller";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-inbox-test",
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

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;

let staffId = "";
const userId = async (email: string) =>
  (await one<{ id: string }>("SELECT id FROM staff_users WHERE email=$1", [email])).id;
/** What the worker does: one notification and a receipt per recipient. */
async function notify(type: string, title: string, recipients: string[]) {
  const { id } = await one<{ id: string }>(
    "INSERT INTO notifications (source_event_id, type, title, body, link) VALUES ($1, $2, $3, 'Body', '/orders/x') RETURNING id",
    [randomUUID(), type, title],
  );
  for (const recipient of recipients)
    await pool.query(
      "INSERT INTO notification_receipts (notification_id, user_id) VALUES ($1, $2)",
      [id, recipient],
    );
  return id;
}
const inbox = (query = "", cookie = staff) =>
  fetch(`${base}/v1/admin/notifications${query}`, {
    headers: { cookie, "x-ih-client-ip": "192.0.2.211" },
  });
const post = (path: string, body: unknown, cookie = staff) =>
  fetch(`${base}/v1/admin/notifications${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin: ADMIN,
      "content-type": "application/json",
      "x-ih-client-ip": "192.0.2.212",
    },
    body: JSON.stringify(body),
  });
const setPermission = async (key: string, enabled: boolean) =>
  pool.query(
    enabled
      ? "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key=$2 ON CONFLICT DO NOTHING"
      : "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key=$2",
    [staffRoleId, key],
  );
/** An open event stream and a way to wait for what it says. */
async function openStream(cookie: string, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/admin/events/stream`, {
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.213",
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    signal: controller.signal,
  });
  let text = "";
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader!.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted
    } finally {
      ended = true;
    }
  })();
  const until = async (test: (all: string) => boolean, ms = 8000) => {
    const start = Date.now();
    while (!test(text)) {
      if (Date.now() - start > ms) throw new Error("timed out waiting for: " + text.slice(-300));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return text;
  };
  const stop = async () => {
    controller.abort();
    await pump;
  };
  return { response, until, stop, ended: () => ended };
}

describe("staff inbox and event stream through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "Inbox Owner" : "Inbox Staff",
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
    const o = await login("owner", "inbox-owner@iqoshaven.test");
    const s = await login("staff", "inbox-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffId = s.id;
    staffRoleId = s.roleId;
    await db.setting.create({
      data: {
        key: "delivery",
        value: { flatFeeFils: 1500, etaText: "Seed ETA", freeThresholdFils: null },
        updatedBy: ownerId,
      },
    });
  });
  Object.assign(EVENT_STREAM, { pollMs: 100, authCheckMs: 200, heartbeatMs: 300, perUser: 3 });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("keeps each user's read flag their own and lists newest first", async () => {
    const ownerId = await userId("inbox-owner@iqoshaven.test");
    const first = await notify("order.new", "New order IH-000001", [ownerId, staffId]);
    const second = await notify("order.new", "New order IH-000002", [ownerId, staffId]);
    const ownerOnly = await notify("order.new", "New order IH-000003", [ownerId]);
    const list = inboxResponseSchema.parse(await (await inbox()).json());
    expect(list.items.map((item) => item.id)).toEqual([second, first]);
    expect(list.unreadCount).toBe(2);
    expect((await inbox()).headers.get("cache-control")).toBe("private, no-store");
    // Staff reads one: only the staff member's receipt changes; reading again keeps the time.
    const read = notificationReadResponseSchema.parse(
      await (await post(`/${first}/read`, {})).json(),
    );
    const again = notificationReadResponseSchema.parse(
      await (await post(`/${first}/read`, {})).json(),
    );
    expect(again.readAt).toBe(read.readAt);
    const ownerView = inboxResponseSchema.parse(await (await inbox("", owner)).json());
    expect(ownerView.items.find((item) => item.id === first)!.readAt).toBeNull();
    expect(ownerView.unreadCount).toBe(3);
    // Someone else's notification is not found, not read.
    expect((await post(`/${ownerOnly}/read`, {})).status).toBe(404);
    expect((await post(`/${randomUUID()}/read`, {})).status).toBe(404);
    // Paging and the unread filter.
    const page = inboxResponseSchema.parse(await (await inbox("?limit=1")).json());
    expect(page.items.map((item) => item.id)).toEqual([second]);
    const rest = inboxResponseSchema.parse(
      await (await inbox(`?limit=1&after=${page.nextCursor}`)).json(),
    );
    expect(rest.items.map((item) => item.id)).toEqual([first]);
    const unread = inboxResponseSchema.parse(await (await inbox("?unread=true")).json());
    expect(unread.items.map((item) => item.id)).toEqual([second]);
    // Read all up to what was seen.
    expect(await (await post("/read-all", { upTo: second })).json()).toEqual({ updated: 1 });
    expect(inboxResponseSchema.parse(await (await inbox()).json()).unreadCount).toBe(0);
    expect((await post("/read-all", { upTo: "x" })).status).toBe(400);
  });

  it("shows a notification only to users who hold its permission now", async () => {
    const id = await notify("order.new", "New order IH-000010", [staffId]);
    await notify("inventory.low", "Low stock", [staffId]);
    await setPermission("orders.read", false);
    try {
      const list = inboxResponseSchema.parse(await (await inbox()).json());
      expect(list.items.map((item) => item.type)).not.toContain("order.new");
      expect(list.items.map((item) => item.title)).toContain("Low stock");
      expect((await post(`/${id}/read`, {})).status).toBe(404);
    } finally {
      await setPermission("orders.read", true);
    }
    // Low-stock alerts need the right to see stock (step 92).
    await setPermission("inventory.read", false);
    try {
      const list = inboxResponseSchema.parse(await (await inbox()).json());
      expect(list.items.map((item) => item.type)).not.toContain("inventory.low");
      expect(list.items.map((item) => item.type)).toContain("order.new");
    } finally {
      await setPermission("inventory.read", true);
    }
    await setPermission("notifications.read_own", false);
    try {
      expect((await inbox()).status).toBe(403);
      expect(
        (await fetch(`${base}/v1/admin/events/stream`, { headers: { cookie: staff } })).status,
      ).toBe(403);
    } finally {
      await setPermission("notifications.read_own", true);
    }
  });

  it("streams new notifications by ID, resumes after Last-Event-ID, and bounds connections", async () => {
    const stream = await openStream(staff);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.response.headers.get("cache-control")).toBe("no-store");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
    await stream.until((text) => text.includes("event: ready"));
    const id = await notify("order.new", "New order IH-000020", [staffId]);
    const text = await stream.until((all) => all.includes(`id: ${id}`));
    expect(text).toContain(`event: notification\ndata: {"id":"${id}","type":"order.new"}`);
    // The content is not in the event: the browser reads it from the inbox.
    expect(text).not.toContain("IH-000020");
    await stream.until((all) => all.includes(": ping"));
    await stream.stop();
    // Two notifications arrive while disconnected; reconnecting after the last seen ID sends both.
    const missedA = await notify("order.new", "Missed A", [staffId]);
    const missedB = await notify("order.new", "Missed B", [staffId]);
    const resumed = await openStream(staff, id);
    await resumed.until((all) => all.includes(`id: ${missedA}`) && all.includes(`id: ${missedB}`));
    await resumed.stop();
    // Per-user bound.
    const open = [await openStream(staff), await openStream(staff), await openStream(staff)];
    for (const one of open) await one.until((all) => all.includes("event: ready"));
    const fourth = await fetch(`${base}/v1/admin/events/stream`, { headers: { cookie: staff } });
    expect(fourth.status).toBe(429);
    for (const one of open) await one.stop();
  });

  it("ends the stream when the session is revoked", async () => {
    const response = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: {
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": "192.0.2.214",
      },
      body: JSON.stringify({ email: "inbox-staff@iqoshaven.test", password: PASSWORD }),
    });
    const second = response.headers.get("set-cookie")!.split(";")[0]!;
    const stream = await openStream(second);
    await stream.until((text) => text.includes("event: ready"));
    await pool.query(
      "UPDATE sessions SET revoked_at=statement_timestamp(), revoke_reason='logout' WHERE user_id=$1 AND revoked_at IS NULL AND id <> (SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1)",
      [staffId],
    );
    await stream.until((text) => text.includes("event: signed-out"));
    await stream.until(() => stream.ended());
    await stream.stop();
  });

  it("ends the stream when the inbox right is taken away, and frees its slot", async () => {
    const stream = await openStream(staff);
    await stream.until((text) => text.includes("event: ready"));
    await setPermission("notifications.read_own", false);
    try {
      await stream.until((text) => text.includes("event: reconnect"));
      await stream.until(() => stream.ended());
    } finally {
      await setPermission("notifications.read_own", true);
    }
    await stream.stop();
    // The slots of ended and aborted streams are free again.
    const again = [await openStream(staff), await openStream(staff), await openStream(staff)];
    for (const one of again) await one.until((text) => text.includes("event: ready"));
    for (const one of again) await one.stop();
  });

  // Step 118: the real commands, not a direct revocation, end an open stream.
  async function signedIn(email: string) {
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const user = await db.staffUser.create({
      data: {
        email,
        name: "Stream Staff",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    const response = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: {
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": "192.0.2.215",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }
  const owners = () => ({ requestId: randomUUID(), actorId: ownerId });

  it("ends the stream when the Owner deactivates the staff member", async () => {
    const member = await signedIn("stream-deactivated@iqoshaven.test");
    const stream = await openStream(member.cookie);
    await stream.until((text) => text.includes("event: ready"));
    const { version } = await db.staffUser.findUniqueOrThrow({ where: { id: member.id } });
    await deactivateStaff(db, owners(), member.id, version);
    await stream.until((text) => text.includes("event: signed-out"));
    await stream.until(() => stream.ended());
    await stream.stop();
    // And the same cookie opens no new one.
    expect(
      (await fetch(`${base}/v1/admin/events/stream`, { headers: { cookie: member.cookie } }))
        .status,
    ).toBe(401);
  });

  it("ends the stream when the Owner changes the staff member's role", async () => {
    const member = await signedIn("stream-promoted@iqoshaven.test");
    const stream = await openStream(member.cookie);
    await stream.until((text) => text.includes("event: ready"));
    const { version } = await db.staffUser.findUniqueOrThrow({ where: { id: member.id } });
    await changeStaffRole(db, owners(), member.id, { version, role: "owner" });
    await stream.until((text) => text.includes("event: signed-out"));
    await stream.until(() => stream.ended());
    await stream.stop();
    expect(
      (await fetch(`${base}/v1/admin/events/stream`, { headers: { cookie: member.cookie } }))
        .status,
    ).toBe(401);
  });
});
