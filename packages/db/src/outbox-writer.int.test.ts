import { randomUUID } from "node:crypto";
import { toAuditEntry } from "@ih/application";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent, type DomainEvent } from "@ih/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAuditWriter } from "./audit";
import { createDatabase, createPool, Prisma, type Tx } from "./client";
import { OutboxOutsideTransactionError, PrismaOutboxWriter } from "./outbox";
import { applyMigrations } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-int-test",
});
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const db = createDatabase(pool, { schema: namespace });
// Stand-in for a business table until real aggregates exist.
const mutations = Prisma.raw('"' + namespace + '"."probe_mutation"');
const outbox = new PrismaOutboxWriter();
const audit = new PrismaAuditWriter();

const probe = (probeId = randomUUID()) => defineEvent("system.probe", probeId, { probeId });

/** One business command: mutation + audit + event in a single unit of work. */
async function command(tx: Tx, id: string, event: DomainEvent): Promise<string> {
  await tx.$executeRaw(Prisma.sql`INSERT INTO ${mutations} (id) VALUES (${id}::uuid)`);
  await audit.append(
    tx,
    toAuditEntry(
      { requestId: "req-" + id, actorId: null },
      { action: "probe.created", entity: { type: "probe", id }, after: { id } },
    ),
  );
  return outbox.publish(tx, event);
}

describe("PrismaOutboxWriter (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    await pool.query('CREATE TABLE "' + namespace + '".probe_mutation (id uuid primary key)');
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("commits mutation, audit, event and required effects together", async () => {
    const id = randomUUID();
    const event = probe(id);
    const eventId = await withTransaction(db, (tx) => command(tx, id, event));
    const row = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: { effects: true },
    });
    expect(row).toMatchObject({
      eventType: "system.probe",
      schemaVersion: 1,
      aggregateType: "system",
      aggregateId: id,
      payload: { probeId: id },
      completedAt: null,
      dispatchedAt: null,
    });
    expect(row.effects.map((effect) => [effect.consumer, effect.status])).toEqual([
      ["system_probe", "pending"],
    ]);
    expect(await db.auditLog.count({ where: { requestId: "req-" + id } })).toBe(1);
  });

  it("rolls everything back when the command fails after publishing", async () => {
    const id = randomUUID();
    await expect(
      withTransaction(db, async (tx) => {
        await command(tx, id, probe(id));
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(0);
    expect(await db.auditLog.count({ where: { requestId: "req-" + id } })).toBe(0);
    const rows = await db.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM ${mutations} WHERE id = ${id}::uuid`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("marks an event with no required consumers complete at write time", async () => {
    const orderId = randomUUID();
    const eventId = await withTransaction(db, (tx) =>
      outbox.publish(tx, defineEvent("order.created", orderId, { orderId }, 0)),
    );
    const row = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: { effects: true },
    });
    expect(row.completedAt).toEqual(row.createdAt);
    expect(row.dispatchedAt).toBeNull();
    expect(row.aggregateVersion).toBe(0n);
    expect(row.effects).toEqual([]);
  });

  it("writes distinct events for two publishes in one command", async () => {
    const id = randomUUID();
    const [first, second] = await withTransaction(db, async (tx) => [
      await outbox.publish(tx, probe(id)),
      await outbox.publish(tx, probe(id)),
    ]);
    expect(first).not.toBe(second);
    expect(await db.consumerEffect.count({ where: { eventId: { in: [first!, second!] } } })).toBe(
      2,
    );
  });

  it("refuses a root client", async () => {
    await expect(outbox.publish(db as never, probe())).rejects.toBeInstanceOf(
      OutboxOutsideTransactionError,
    );
  });

  it.each([
    ["forged consumer set", { consumers: ["notification"] }],
    ["dropped consumer", { consumers: [] }],
    ["stale schema version", { schemaVersion: 2 }],
    ["wrong aggregate type", { aggregateType: "order" }],
    ["unknown type", { type: "order.deleted" }],
    ["negative aggregate version", { aggregateVersion: -1 }],
    ["fractional aggregate version", { aggregateVersion: 1.5 }],
    ["personal data in payload", { payload: { probeId: randomUUID(), phone: "+971500000000" } }],
  ])("rejects a caller-assembled event with %s", async (_name, patch) => {
    const id = randomUUID();
    await expect(
      withTransaction(db, (tx) => command(tx, id, { ...probe(id), ...patch } as never)),
    ).rejects.toThrow();
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(0);
  });
});
