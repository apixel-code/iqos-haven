import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, transitionOrder } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnalyticsRollupConsumer } from "./analytics-rollup";
import { EffectRunner } from "./effects";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-analytics-rollup-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "analytics-rollup-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const runner = new EffectRunner({
  db,
  owner: "analytics-test",
  log,
  handlers: [createAnalyticsRollupConsumer({ log })],
});
let ownerId = "";
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
/** The analytics jobs of every event written so far. */
async function jobs() {
  const effects = await db.consumerEffect.findMany({
    where: { consumer: "analytics_rollup" },
    include: { event: true },
    orderBy: { createdAt: "asc" },
  });
  return effects.map((effect) => ({
    type: effect.event.eventType,
    job: { eventId: effect.eventId, effectId: effect.id, consumer: "analytics_rollup" as const },
  }));
}

describe("analytics rollup consumer (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    ownerId = (
      await db.staffUser.create({
        data: {
          email: "analytics-owner@iqoshaven.test",
          name: "Analytics Owner",
          roleId: (await db.role.findUniqueOrThrow({ where: { key: "owner" } })).id,
          passwordHash: HASH,
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("recomputes the order's days on each order event, once however often delivered", async () => {
    const order = await seedOrder(pool, { status: "confirmed" });
    for (const to of ["processing", "out_for_delivery", "delivered"] as const) {
      const { version } = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
      await transitionOrder(db, { requestId: randomUUID(), actorId: ownerId }, order.orderId, {
        to,
        expectedVersion: version,
        commandId: randomUUID(),
      });
    }
    const all = await jobs();
    expect(all.map((item) => item.type)).toEqual([
      "order.status_changed",
      "order.status_changed",
      "order.status_changed",
    ]);
    for (const item of all) expect(await runner.run(item.job)).toBe("completed");
    const day = await db.salesDaily.findUniqueOrThrow({ where: { day: new Date(today()) } });
    expect(day).toMatchObject({ placedOrders: 1, deliveredOrders: 1, collectedOrders: 0 });
    expect(Number(day.deliveredTotalFils)).toBe(6_500);
    // Redelivery after completion does nothing; the figures stay the same.
    expect(await runner.run(all[0]!.job)).toBe("duplicate");
    expect(
      (await db.salesDaily.findUniqueOrThrow({ where: { day: new Date(today()) } }))
        .deliveredOrders,
    ).toBe(1);
    const units = await db.productSalesDaily.aggregate({ _sum: { deliveredUnits: true } });
    expect(units._sum.deliveredUnits).toBe(1);
  });
});
