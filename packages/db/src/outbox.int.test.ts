import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent } from "@ih/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool, Prisma } from "./client";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-int-test",
});
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const db = createDatabase(pool, { schema: namespace });
const events = Prisma.raw('"' + namespace + '"."outbox_events"');
const effects = Prisma.raw('"' + namespace + '"."consumer_effects"');

async function writeProbe() {
  const event = defineEvent("system.probe", "probe", { probeId: randomUUID() });
  const row = await db.outboxEvent.create({
    data: {
      eventType: event.type,
      schemaVersion: event.schemaVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      effects: { create: event.consumers.map((consumer) => ({ consumer })) },
    },
    include: { effects: true },
  });
  return row;
}

describe("outbox_events / consumer_effects (real PostgreSQL)", () => {
  beforeAll(() => applyMigrations(pool, namespace));
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("stores a catalogue event with its snapshotted required effects", async () => {
    const row = await writeProbe();
    expect(row.id[14]).toBe("7");
    expect(row.schemaVersion).toBe(1);
    expect(row.effects.map((effect) => [effect.consumer, effect.status])).toEqual([
      ["system_probe", "pending"],
    ]);
  });

  it("deduplicates effects per (event, consumer)", async () => {
    const row = await writeProbe();
    await expect(
      db.consumerEffect.create({ data: { eventId: row.id, consumer: "system_probe" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps event identity/payload immutable but allows relay bookkeeping", async () => {
    const row = await writeProbe();
    await expect(
      db.outboxEvent.update({
        where: { id: row.id },
        data: { payload: { probeId: randomUUID() } },
      }),
    ).rejects.toThrow(/immutable/);
    const leased = await db.outboxEvent.update({
      where: { id: row.id },
      data: {
        leaseOwner: "relay-1",
        leaseExpiresAt: new Date(Date.now() + 30_000),
        dispatchAttempts: { increment: 1 },
      },
    });
    expect(leased.dispatchAttempts).toBe(1);
  });

  it("never deletes incomplete events or their effects", async () => {
    const row = await writeProbe();
    await expect(
      db.$executeRaw(Prisma.sql`DELETE FROM ${effects} WHERE event_id = ${row.id}::uuid`),
    ).rejects.toThrow(/pruning a completed event/);
    await expect(
      db.$executeRaw(Prisma.sql`DELETE FROM ${events} WHERE id = ${row.id}::uuid`),
    ).rejects.toThrow(/incomplete outbox event/);
  });

  it("enforces effect status rules and terminal completion", async () => {
    const row = await writeProbe();
    const id = row.effects[0]!.id;
    await expect(
      db.consumerEffect.update({ where: { id }, data: { status: "unknown" } }),
    ).rejects.toThrow();
    await expect(
      db.consumerEffect.update({ where: { id }, data: { status: "running" } }),
    ).rejects.toThrow();
    await expect(
      db.consumerEffect.update({
        where: { id },
        data: { status: "skipped", completedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      db.consumerEffect.update({ where: { id }, data: { status: "completed" } }),
    ).rejects.toThrow();

    const before = await db.consumerEffect.findUniqueOrThrow({ where: { id } });
    const done = await db.consumerEffect.update({
      where: { id },
      data: { status: "completed", completedAt: new Date(), attempts: 1 },
    });
    expect(done.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    await expect(
      db.consumerEffect.update({ where: { id }, data: { status: "pending", completedAt: null } }),
    ).rejects.toThrow(/terminal/);
  });

  it("completes an event only after every required effect finished", async () => {
    const row = await writeProbe();
    const effectId = row.effects[0]!.id;
    await expect(
      db.outboxEvent.update({ where: { id: row.id }, data: { completedAt: new Date() } }),
    ).rejects.toThrow(/unfinished effects/);
    await db.consumerEffect.update({
      where: { id: effectId },
      data: { status: "completed", completedAt: new Date() },
    });
    await db.outboxEvent.update({ where: { id: row.id }, data: { completedAt: new Date() } });
    await expect(
      db.outboxEvent.update({ where: { id: row.id }, data: { completedAt: null } }),
    ).rejects.toThrow(/reopened/);
    // A late consumer must not silently redefine completion of an old event.
    await expect(
      db.consumerEffect.create({ data: { eventId: row.id, consumer: "notification" } }),
    ).rejects.toThrow(/completed or missing event/);
    // Pruning path (maintenance role, BI-08): completed effects first, then the completed event.
    await expect(
      db.$executeRaw(Prisma.sql`DELETE FROM ${events} WHERE id = ${row.id}::uuid`),
    ).rejects.toThrow();
    await db.$transaction([
      db.$executeRaw(Prisma.sql`DELETE FROM ${effects} WHERE event_id = ${row.id}::uuid`),
      db.$executeRaw(Prisma.sql`DELETE FROM ${events} WHERE id = ${row.id}::uuid`),
    ]);
    expect(await db.outboxEvent.count({ where: { id: row.id } })).toBe(0);
  });

  it("keeps dead effects investigable and replayable only to pending/retry", async () => {
    const row = await writeProbe();
    const id = row.effects[0]!.id;
    await expect(
      db.consumerEffect.update({ where: { id }, data: { status: "dead" } }),
    ).rejects.toThrow();
    await expect(
      db.consumerEffect.update({
        where: { id },
        data: { status: "queued", queuedAt: null },
      }),
    ).rejects.toThrow();
    await expect(
      db.consumerEffect.update({
        where: { id },
        data: {
          status: "dead",
          lastError: "PERMANENT",
          leaseOwner: "w1",
          leaseExpiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    await db.consumerEffect.update({
      where: { id },
      data: { status: "dead", lastError: "PERMANENT_PAYLOAD" },
    });
    await expect(
      db.consumerEffect.update({
        where: { id },
        data: { status: "completed", completedAt: new Date() },
      }),
    ).rejects.toThrow(/replayed/);
    await expect(db.consumerEffect.update({ where: { id }, data: { replays: 5 } })).rejects.toThrow(
      /replay count/,
    );
    const replayed = await db.consumerEffect.update({
      where: { id },
      data: { status: "pending" },
    });
    expect(replayed.replays).toBe(1);
  });

  it("rejects oversized or non-object payloads in the database", async () => {
    const base = {
      eventType: "system.probe",
      schemaVersion: 1,
      aggregateType: "system",
      aggregateId: "p",
    };
    await expect(
      db.outboxEvent.create({ data: { ...base, payload: { blob: "x".repeat(5000) } } }),
    ).rejects.toThrow();
    await expect(db.outboxEvent.create({ data: { ...base, payload: [1, 2] } })).rejects.toThrow();
    await expect(
      db.outboxEvent.create({ data: { ...base, schemaVersion: 0, payload: {} } }),
    ).rejects.toThrow();
  });
});
