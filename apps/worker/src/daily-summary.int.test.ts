import { randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { backfillRollups, createDatabase, createPool, readSalesDays } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { addDays, dubaiDate } from "@ih/domain";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLateEditRollupJob, createTodayRollupJob, LATE_EDIT_DAYS } from "./analytics-rollup";
import {
  createDailySummaryJob,
  dailySummaryEmailPlanner,
  DAILY_SUMMARY_JOB,
} from "./daily-summary";
import { EffectRunner } from "./effects";
import { Scheduler } from "./scheduler";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-daily-summary-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "daily-summary-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const OWNER = "summary-owner@iqoshaven.test";
const STAFF = "summary-staff@iqoshaven.test";
const FORMER = "summary-former@iqoshaven.test";
const OUTSIDER = "accountant@example.test";
let ownerId = "";
const today = () => dubaiDate(new Date());
/** The 09:00 Dubai slot whose summary covers `day` (the next morning). */
const slotFor = (day: string) => new Date(addDays(day, 1) + "T05:00:00Z");

const setNotifications = async (value: unknown) => {
  await pool.query("DELETE FROM settings WHERE key='notifications'");
  if (value)
    await db.setting.create({
      data: { key: "notifications", updatedBy: ownerId, value: value as object },
    });
};
const summaryEvents = () =>
  db.outboxEvent.findMany({
    where: { eventType: "report.daily_summary" },
    include: { effects: true },
    orderBy: { id: "asc" },
  });
function mailer() {
  const messages: EmailMessage[] = [];
  const runner = new EffectRunner({
    db,
    owner: "daily-summary-email-test",
    log,
    handlers: [
      createEmailConsumer({
        from: "no-reply@iqoshaven.local",
        planners: { "report.daily_summary": dailySummaryEmailPlanner(db, log) },
        adapter: {
          send: async (message) => {
            messages.push(message);
            return { receipt: "test:" + message.deliveryKey, accepted: 1, rejected: 0 };
          },
        },
      }),
    ],
  });
  return { messages, runner };
}
async function sendSummaryOf(day: string) {
  const event = (await summaryEvents()).find((row) => row.aggregateId === day)!;
  const effect = event.effects.find((row) => row.consumer === "email")!;
  const { messages, runner } = mailer();
  expect(await runner.run({ eventId: event.id, effectId: effect.id, consumer: "email" })).toBe(
    "completed",
  );
  return messages;
}

describe("daily summary and scheduled rollups (real PostgreSQL)", () => {
  const summary = () => createDailySummaryJob({ db, log });
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = async (key: string) => (await db.role.findUniqueOrThrow({ where: { key } })).id;
    const user = async (email: string, roleId: string, active = true) =>
      (
        await db.staffUser.create({
          data: { email, name: "Summary", roleId, active, passwordHash: HASH },
        })
      ).id;
    ownerId = await user(OWNER, await role("owner"));
    await user(STAFF, await role("staff"));
    await user(FORMER, await role("owner"), false);
    await seedOrder(pool); // pending: 5000 + 1500 delivery
    await seedOrder(pool, { status: "confirmed", quantity: 2 }); // 10000 + 1500
  });
  beforeEach(async () => {
    await setNotifications({
      inApp: true,
      newOrderEmail: { enabled: false, recipients: [OWNER, STAFF, FORMER, OUTSIDER] },
      dailySummaryEmail: true,
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("writes one summary event per day, whatever replica or retry runs the slot", async () => {
    // A slot already due by the database clock: the summary of two days ago.
    const day = addDays(today(), -2);
    const slot = slotFor(day);
    // Two replicas tick the same moment: one slot, one run.
    const a = new Scheduler({ db, owner: "summary-a", log, jobs: [summary()] });
    const b = new Scheduler({ db, owner: "summary-b", log, jobs: [summary()] });
    const runs = await Promise.all([a.tick(slot), b.tick(slot)]);
    expect(runs.reduce((sum, run) => sum + run.completed, 0)).toBe(1);
    // A reclaimed or repeated run of that slot, even several at once, adds no event.
    await Promise.all([summary().run(slot), summary().run(slot), summary().run(slot)]);
    const events = (await summaryEvents()).filter((row) => row.aggregateId === day);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateType: "report", payload: { day } });
    expect(events[0]!.effects.map((effect) => effect.consumer)).toEqual(["email"]);
    expect(
      await db.scheduledRun.count({ where: { jobName: DAILY_SUMMARY_JOB, status: "completed" } }),
    ).toBe(1);
    // The database refuses a second event for the day even without the lock.
    await expect(
      pool.query(
        `INSERT INTO outbox_events (event_type, schema_version, aggregate_type, aggregate_id, payload)
         VALUES ('report.daily_summary', 1, 'report', $1, $2)`,
        [day, JSON.stringify({ day })],
      ),
    ).rejects.toThrow(/outbox_events_one_daily_summary/);
  });

  it("emails only listed addresses of active staff allowed to see revenue", async () => {
    await summary().run(slotFor(today()));
    const messages = await sendSummaryOf(today());
    expect(messages).toHaveLength(1);
    // Not the staff without the right, the deactivated Owner, or an address with no account.
    expect(messages[0]!.bcc).toEqual([OWNER]);
    expect(messages[0]!.subject).toBe(`Daily summary for ${today()}`);
    const text = messages[0]!.text;
    expect(text).toContain("Placed: 2 active orders, AED 180.00 (by order date)");
    expect(text).toContain("Delivered: 0 orders, AED 0.00");
    expect(text).toContain("Cash collected: 0 orders, AED 0.00");
    expect(text).toContain("Asia/Dubai");
    expect(text).toContain("no separate VAT or excise");
    // No order numbers, customers or links.
    expect(text).not.toMatch(/https?:|Seed Customer|\+971/);
  });

  it("sends nothing while switched off, or when nobody listed may see revenue", async () => {
    // Each case is a fresh day: a completed email effect is never performed again.
    const quiet = addDays(today(), -30);
    const unlisted = addDays(today(), -31);
    await summary().run(slotFor(quiet));
    await summary().run(slotFor(unlisted));
    await setNotifications(null);
    expect(await sendSummaryOf(quiet)).toEqual([]);
    await setNotifications({
      inApp: true,
      newOrderEmail: { enabled: false, recipients: [STAFF, OUTSIDER] },
      dailySummaryEmail: true,
    });
    expect(await sendSummaryOf(unlisted)).toEqual([]);
  });

  it("keeps today and the recent days fresh, and reports days not computed", async () => {
    const day = today();
    await pool.query("DELETE FROM sales_daily");
    expect((await readSalesDays(db, addDays(day, -1), day)).missing).toEqual([
      addDays(day, -1),
      day,
    ]);
    await createTodayRollupJob({ db, log }).run(new Date());
    const fresh = await readSalesDays(db, addDays(day, -1), day);
    expect(fresh.missing).toEqual([]);
    expect(fresh.days.map((row) => row.day)).toEqual([addDays(day, -1), day]);
    expect(fresh.days[1]).toMatchObject({ placedOrders: 2, bookedTotalFils: 18_000 });
    const first = fresh.days[1]!.computedAt;
    await createTodayRollupJob({ db, log }).run(new Date());
    const again = (await readSalesDays(db, day, day)).days[0]!;
    // Recomputed, not added: same figures, newer freshness.
    expect(again).toMatchObject({ placedOrders: 2, bookedTotalFils: 18_000 });
    expect(again.computedAt.getTime()).toBeGreaterThanOrEqual(first.getTime());

    // The nightly pass covers the seven days before today, and not today.
    await createLateEditRollupJob({ db, log }).run(new Date(day + "T00:00:00Z"));
    const week = await readSalesDays(db, addDays(day, -LATE_EDIT_DAYS), day);
    expect(week.missing).toEqual([]);
    expect(week.days).toHaveLength(LATE_EDIT_DAYS + 1);
  });

  it("backfills a named range once, and refuses days after today", async () => {
    const from = addDays(today(), -20);
    const to = addDays(today(), -10);
    const seen: string[] = [];
    expect(await backfillRollups(db, from, to, { onDay: (day) => seen.push(day) })).toEqual({
      days: 11,
    });
    expect(seen[0]).toBe(from);
    expect(seen.at(-1)).toBe(to);
    const before = await readSalesDays(db, from, to);
    await backfillRollups(db, from, to);
    const after = await readSalesDays(db, from, to);
    expect(after.days.map((row) => row.placedOrders)).toEqual(
      before.days.map((row) => row.placedOrders),
    );
    await expect(backfillRollups(db, today(), addDays(today(), 1))).rejects.toThrow(/after today/);
    await expect(backfillRollups(db, "2024-01-01", "2026-01-01")).rejects.toThrow(/longer/);
  });
});
