import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { orderBulkConfirmResponseSchema } from "@ih/contracts";
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
  applicationName: "ih-bulk-confirm-test",
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

const send = (path: string, method: string, body: unknown, cookie: string, origin = ADMIN) =>
  fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      // Each call from its own address keeps the per-address limiter out of the way.
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const order = async (orderId: string) =>
  one<{
    status: string;
    version: number;
    cod: string;
    reason: string | null;
    returned: Date | null;
  }>(
    "SELECT status, version, cod_status AS cod, cancel_reason AS reason, returned_at AS returned FROM orders WHERE id=$1",
    [orderId],
  );
const count = async (sql: string, params: unknown[]) =>
  Number((await one<{ n: string }>(sql, params)).n);

async function moveTo(orderId: string, targets: string[]) {
  for (const to of targets) {
    const { version } = await order(orderId);
    const response = await send(
      `/${orderId}/transitions`,
      "POST",
      { to, expectedVersion: version, commandId: randomUUID() },
      owner,
    );
    expect(response.status).toBe(200);
  }
}
const history = (orderId: string) =>
  count("SELECT count(*) AS n FROM order_status_history WHERE order_id=$1", [orderId]);
const bulk = (body: unknown, cookie = staff) => send("/bulk-confirm", "POST", body, cookie);
const entry = (orderId: string, expectedVersion = 1) => ({
  orderId,
  expectedVersion,
  commandId: randomUUID(),
});
const statusOf = async (orderId: string) => (await order(orderId)).status;

describe("bulk confirm through the real API and PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const login = async (key: "owner" | "staff", email: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { key } });
      const user = await db.staffUser.create({
        data: {
          email,
          name: key === "owner" ? "Bulk Owner" : "Bulk Staff",
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
    const o = await login("owner", "bulk-owner@iqoshaven.test");
    const s = await login("staff", "bulk-staff@iqoshaven.test");
    owner = o.cookie;
    ownerId = o.id;
    staff = s.cookie;
    staffRoleId = s.roleId;
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

  it("confirms each order on its own and reports mixed results", async () => {
    const pending = [await seedOrder(pool), await seedOrder(pool), await seedOrder(pool)];
    const stale = await seedOrder(pool, { status: "confirmed" });
    const delivered = await seedOrder(pool, { status: "confirmed" });
    await moveTo(delivered.orderId, ["processing", "out_for_delivery", "delivered"]);
    const unknown = randomUUID();
    const batch = {
      orders: [
        ...pending.map((seeded) => entry(seeded.orderId)),
        entry(stale.orderId, 7),
        entry(delivered.orderId, 4),
        entry(unknown),
      ],
    };
    const response = await bulk(batch);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { results } = orderBulkConfirmResponseSchema.parse(await response.json());
    expect(results.map((result) => [result.orderId, result.outcome, result.code])).toEqual([
      ...pending.map((seeded) => [seeded.orderId, "confirmed", null]),
      [stale.orderId, "refused", "VERSION_CONFLICT"],
      [delivered.orderId, "refused", "INVALID_TRANSITION"],
      [unknown, "refused", "NOT_FOUND"],
    ]);
    for (const seeded of pending) {
      expect(await statusOf(seeded.orderId)).toBe("confirmed");
      expect(await history(seeded.orderId)).toBe(2);
    }
    expect(await statusOf(stale.orderId)).toBe("confirmed");
    expect(await history(stale.orderId)).toBe(1);
    expect(await statusOf(delivered.orderId)).toBe("delivered");

    // The same batch again: every confirmation replays, nothing is confirmed twice.
    const again = orderBulkConfirmResponseSchema.parse(await (await bulk(batch)).json());
    expect(
      again.results
        .slice(0, 3)
        .every((result) => result.outcome === "confirmed" && result.replayed),
    ).toBe(true);
    expect(again.results.slice(0, 3).map((result) => result.orderVersion)).toEqual(
      results.slice(0, 3).map((result) => result.orderVersion),
    );
    for (const seeded of pending) expect(await history(seeded.orderId)).toBe(2);
    // A new batch with new command IDs for the same, now confirmed, orders is refused.
    const fresh = orderBulkConfirmResponseSchema.parse(
      await (await bulk({ orders: pending.map((seeded) => entry(seeded.orderId)) })).json(),
    );
    expect(fresh.results.map((result) => result.code)).toEqual([
      "VERSION_CONFLICT",
      "VERSION_CONFLICT",
      "VERSION_CONFLICT",
    ]);
    for (const seeded of pending) expect(await history(seeded.orderId)).toBe(2);
  });

  it("confirms each order once when the same batch arrives twice at once", async () => {
    const seeded = [
      await seedOrder(pool),
      await seedOrder(pool),
      await seedOrder(pool),
      await seedOrder(pool),
    ];
    const batch = { orders: seeded.map((one) => entry(one.orderId)) };
    const [first, second] = await Promise.all([bulk(batch), bulk(batch, staff)]);
    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      const { results } = orderBulkConfirmResponseSchema.parse(await response.json());
      expect(results.every((result) => result.outcome === "confirmed")).toBe(true);
    }
    for (const one of seeded) expect(await history(one.orderId)).toBe(2);
    // Another person's command IDs reused: refused, not applied.
    const reused = orderBulkConfirmResponseSchema.parse(
      await (await bulk({ orders: [{ ...batch.orders[0]!, expectedVersion: 2 }] }, owner)).json(),
    );
    expect(reused.results[0]).toMatchObject({ outcome: "refused", code: "COMMAND_REUSED" });
  });

  it("bounds the batch, refuses duplicates and needs the right to confirm", async () => {
    const one = await seedOrder(pool);
    const many = { orders: Array.from({ length: 51 }, () => entry(randomUUID())) };
    expect((await bulk(many)).status).toBe(400);
    expect((await bulk({ orders: [] })).status).toBe(400);
    const twice = entry(one.orderId);
    expect((await bulk({ orders: [twice, { ...twice, commandId: randomUUID() }] })).status).toBe(
      400,
    );
    expect(
      (await bulk({ orders: [twice, { ...entry(randomUUID()), commandId: twice.commandId }] }))
        .status,
    ).toBe(400);
    expect((await bulk({ orders: [{ ...twice, to: "delivered" }] })).status).toBe(400);
    expect(
      (await send("/bulk-confirm", "POST", { orders: [twice] }, staff, "https://evil.example"))
        .status,
    ).toBe(403);
    await pool.query(
      `DELETE FROM role_permissions rp USING permissions p
       WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='orders.transition'`,
      [staffRoleId],
    );
    try {
      expect((await bulk({ orders: [twice] })).status).toBe(403);
    } finally {
      await pool.query(
        "INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE key='orders.transition'",
        [staffRoleId],
      );
    }
    expect(await statusOf(one.orderId)).toBe("pending");
  });

  it("treats capitals as the same command, refuses a command ID reused for another order, and does not deadlock", async () => {
    const [a, b, c, d] = [
      await seedOrder(pool),
      await seedOrder(pool),
      await seedOrder(pool),
      await seedOrder(pool),
    ];
    const first = entry(a!.orderId);
    expect((await bulk({ orders: [first] })).status).toBe(200);
    const shouted = orderBulkConfirmResponseSchema.parse(
      await (
        await bulk({
          orders: [
            {
              ...first,
              orderId: first.orderId.toUpperCase(),
              commandId: first.commandId.toUpperCase(),
            },
          ],
        })
      ).json(),
    );
    expect(shouted.results[0]).toMatchObject({ outcome: "confirmed", replayed: true });
    expect(await history(a!.orderId)).toBe(2);
    // The same command ID in a later batch for a different order is not that command.
    const reused = orderBulkConfirmResponseSchema.parse(
      await (
        await bulk({
          orders: [{ orderId: b!.orderId, expectedVersion: 1, commandId: first.commandId }],
        })
      ).json(),
    );
    expect(reused.results[0]).toMatchObject({ outcome: "refused", code: "COMMAND_REUSED" });
    expect(await statusOf(b!.orderId)).toBe("pending");
    // Two batches naming the same orders in opposite orders, at once.
    const one = [entry(b!.orderId), entry(c!.orderId), entry(d!.orderId)];
    const other = [entry(d!.orderId), entry(c!.orderId), entry(b!.orderId)];
    const answers = await Promise.all([bulk({ orders: one }), bulk({ orders: other }, owner)]);
    const results = (
      await Promise.all(
        answers.map(async (response) =>
          orderBulkConfirmResponseSchema.parse(await response.json()),
        ),
      )
    ).flatMap((answer) => answer.results);
    for (const seeded of [b, c, d]) {
      const mine = results.filter((result) => result.orderId === seeded!.orderId);
      expect(mine.filter((result) => result.outcome === "confirmed")).toHaveLength(1);
      expect(mine.filter((result) => result.code === "VERSION_CONFLICT")).toHaveLength(1);
      expect(await history(seeded!.orderId)).toBe(2);
    }
  });
});
