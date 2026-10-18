import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { EmailMessage } from "@ih/application";
import { defineEvent } from "@ih/contracts";
import {
  applyAlertEvaluations,
  createDatabase,
  createPool,
  PrismaOutboxWriter,
  withTransaction,
} from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpsMonitorJob, OpsAlerter } from "./ops-monitor";
import { createQueueConnection } from "./queue";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-ops-monitor-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const redis = createQueueConnection(process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379");
const log = createLogger({ service: "ops-monitor-test", level: "silent" });
const sent: EmailMessage[] = [];
const job = createOpsMonitorJob({
  db,
  redis,
  apiTarget: undefined,
  synthetic: {},
  alerter: new OpsAlerter({
    adapter: {
      send: async (message) => {
        sent.push(message);
        return { receipt: "test", accepted: message.bcc.length, rejected: 0 };
      },
    },
    from: "no-reply@iqoshaven.com",
    recipients: ["ops@apixel.test"],
    appEnv: "test",
    log,
  }),
  remindAfterMs: 6 * 3_600_000,
  log,
});
const alert = async (key: string) =>
  (await pool.query("SELECT firing, consecutive FROM ops_alerts WHERE key = $1", [key])).rows[0] as
    { firing: boolean; consecutive: number } | undefined;

describe("ops monitor against PostgreSQL and Redis (step 125)", () => {
  beforeAll(() => applyMigrations(pool, namespace));
  afterAll(async () => {
    redis.disconnect();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("opens an alert once with one email, stays quiet, then resolves", async () => {
    await job.run(new Date());
    expect(await alert("effects.dead")).toMatchObject({ firing: false });
    expect(sent.filter((m) => m.subject.includes("effects."))).toHaveLength(0);

    // A stuck cache invalidation that later dies.
    const productId = randomUUID();
    const eventId = await withTransaction(db, (tx) =>
      new PrismaOutboxWriter().publish(
        tx,
        defineEvent("catalog.changed", productId, { entityType: "product", entityId: productId }),
      ),
    );
    // Age it ten minutes (identity columns are guarded by a trigger outside tests).
    await pool.query("ALTER TABLE consumer_effects DISABLE TRIGGER USER");
    try {
      await pool.query(
        "UPDATE consumer_effects SET created_at = created_at - interval '10 minutes' WHERE event_id = $1",
        [eventId],
      );
    } finally {
      await pool.query("ALTER TABLE consumer_effects ENABLE TRIGGER USER");
    }
    await job.run(new Date());
    expect(await alert("effects.backlog")).toMatchObject({ firing: true });
    expect(await alert("cache.publication")).toMatchObject({ firing: true });
    const opened = sent.at(-1)!;
    expect(opened.subject).toContain("cache.publication");
    expect(opened.subject).toContain("effects.backlog");
    expect(opened.bcc).toEqual(["ops@apixel.test"]);
    const count = sent.length;

    await job.run(new Date());
    expect(sent).toHaveLength(count);

    await pool.query(
      "UPDATE consumer_effects SET status = 'dead', last_error = 'TEST' WHERE event_id = $1",
      [eventId],
    );
    await job.run(new Date());
    expect(await alert("effects.backlog")).toMatchObject({ firing: false });
    expect(await alert("effects.dead")).toMatchObject({ firing: true });
    const last = sent.at(-1)!;
    expect(last.text).toContain("OPENED effects.dead: 1 dead background effect(s)");
    expect(last.text).toContain("RESOLVED effects.backlog");
    // Counts only: no event, product or effect identifiers in the email.
    expect(last.text).not.toContain(productId);
    expect(last.text).not.toContain(eventId);
  });

  it("opens an alert only once when two monitor runs race", async () => {
    const evaluation = [{ key: "race.check", firing: true, summary: "raced", after: 1 }] as const;
    const [a, b] = await Promise.all([
      applyAlertEvaluations(db, evaluation, new Date(), 3_600_000),
      applyAlertEvaluations(db, evaluation, new Date(), 3_600_000),
    ]);
    expect([...a, ...b].filter((notice) => notice.kind === "opened")).toHaveLength(1);
    expect(await alert("race.check")).toMatchObject({ firing: true, consecutive: 2 });
  });
});
