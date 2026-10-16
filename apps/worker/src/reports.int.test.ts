import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  createDatabase,
  createPool,
  failReportFile,
  reportArtifactKey,
  requestReport,
} from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { ObjectStorage, storageConfigFromEnv } from "@ih/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import { createReportBuilderConsumer, createReportUpkeepJob } from "./reports";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-report-builder-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "report-builder-test", level: "silent" });
const storage = new ObjectStorage(
  storageConfigFromEnv({ ...storageEnv, S3_FORCE_PATH_STYLE: true }),
);
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const runner = new EffectRunner({
  db,
  owner: "report-builder-test",
  log,
  handlers: [createReportBuilderConsumer({ db, storage, log })],
});
let ownerId = "";
let clerkId = "";
let clerkRoleId = "";
const keys: string[] = [];

/** A file job (the stream limit lowered to 0), and its report_builder effect. */
async function fileJob(actorId: string, report: Parameters<typeof requestReport>[2]["report"]) {
  const { job } = await requestReport(
    db,
    { requestId: randomUUID(), actorId },
    { commandId: randomUUID(), report },
    { streamMaxRows: -1 },
  );
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: job.id, eventType: "report.requested" },
    include: { effects: true },
  });
  expect(event.effects.map((effect) => effect.consumer)).toEqual(["report_builder"]);
  keys.push(reportArtifactKey(job.id));
  return {
    job,
    effect: {
      eventId: event.id,
      effectId: event.effects[0]!.id,
      consumer: "report_builder" as const,
    },
  };
}
const row = (id: string) => db.reportJob.findUniqueOrThrow({ where: { id } });

describe("report files: build, store and expire (real PostgreSQL and MinIO)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const user = async (email: string, roleId: string) =>
      (await db.staffUser.create({ data: { email, name: "Rep", roleId, passwordHash: HASH } })).id;
    ownerId = await user(
      "builder-owner@iqoshaven.test",
      (await db.role.findUniqueOrThrow({ where: { key: "owner" } })).id,
    );
    clerkRoleId = (await db.role.create({ data: { key: "builder_clerk_test", name: "Rep" } })).id;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('reports.read','reports.export','customers.export')",
      [clerkRoleId],
    );
    clerkId = await user("builder-clerk@iqoshaven.test", clerkRoleId);
    await seedOrder(pool);
    await seedOrder(pool, { quantity: 2 });
  });
  afterAll(async () => {
    for (const key of keys) await storage.delete("reports", key).catch(() => undefined);
    storage.destroy();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("builds a queued file once into the private bucket and keeps it 7 days", async () => {
    const { job, effect } = await fileJob(ownerId, { type: "inventory" });
    expect(await runner.run(effect)).toBe("completed");
    const stored = await row(job.id);
    expect(stored).toMatchObject({
      status: "completed",
      artifactKey: reportArtifactKey(job.id),
      rowCount: 2,
      attempts: 1,
    });
    const days = (stored.expiresAt!.getTime() - stored.completedAt!.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);
    const object = await storage.get("reports", stored.artifactKey!, 1024 * 1024);
    const text = new TextDecoder().decode(object!.body);
    expect([...object!.body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(Number(stored.byteSize)).toBe(object!.size);
    // A redelivered effect does nothing more.
    expect(await runner.run(effect)).toBe("duplicate");
    expect((await row(job.id)).attempts).toBe(1);
  });

  it("refuses to build personal data for a requester who lost the right", async () => {
    const { job, effect } = await fileJob(clerkId, { type: "customers" });
    // As if an earlier attempt had already stored the file.
    await storage.put("reports", reportArtifactKey(job.id), "earlier", "text/csv");
    await pool.query(
      "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='customers.export'",
      [clerkRoleId],
    );
    expect(await runner.run(effect)).toBe("completed");
    expect(await row(job.id)).toMatchObject({
      status: "failed",
      errorCode: "REQUESTER_FORBIDDEN",
      artifactKey: null,
    });
    expect(await storage.head("reports", reportArtifactKey(job.id))).toBeNull();
  });

  it("expires streams, fails builds that never finished, and deletes old files", async () => {
    const upkeep = createReportUpkeepJob({ db, storage, log });
    const { job: stream } = await requestReport(
      db,
      { requestId: randomUUID(), actorId: ownerId },
      { commandId: randomUUID(), report: { type: "inventory" } },
    );
    await pool.query(
      "UPDATE report_jobs SET expires_at = now() - interval '1 second' WHERE id=$1",
      [stream.id],
    );
    const { job: stuck } = await fileJob(ownerId, { type: "inventory" });
    // A slow build of it stored its object before it was given up.
    await storage.put("reports", reportArtifactKey(stuck.id), "partial", "text/csv");
    await pool.query(
      "UPDATE consumer_effects SET status='dead', last_error='TEST_DEAD' WHERE event_id IN (SELECT id FROM outbox_events WHERE aggregate_id=$1)",
      [stuck.id],
    );
    const { job: old, effect } = await fileJob(ownerId, { type: "inventory" });
    expect(await runner.run(effect)).toBe("completed");
    await pool.query(
      "UPDATE report_jobs SET expires_at = now() - interval '1 second' WHERE id=$1",
      [old.id],
    );
    expect(await storage.head("reports", reportArtifactKey(old.id))).not.toBeNull();

    await upkeep.run(new Date());
    expect((await row(stream.id)).status).toBe("expired");
    expect(await row(stuck.id)).toMatchObject({
      status: "failed",
      errorCode: "BUILD_NOT_FINISHED",
    });
    const expired = await row(old.id);
    // The record stays, the file goes.
    expect(expired).toMatchObject({ status: "expired", artifactKey: reportArtifactKey(old.id) });
    expect(await storage.head("reports", reportArtifactKey(old.id))).toBeNull();
    // Running it again changes nothing.
    await upkeep.run(new Date());
    expect((await row(old.id)).status).toBe("expired");
  });

  it("leaves no file behind when the job is given up while its upload runs", async () => {
    const { job, effect } = await fileJob(ownerId, { type: "inventory" });
    // Upkeep fails the job during the upload (a slow build past the stale limit).
    const racing = new Proxy(storage, {
      get(target, name, receiver) {
        if (name === "put")
          return async (...args: Parameters<ObjectStorage["put"]>) => {
            await failReportFile(db, job.id, "BUILD_NOT_FINISHED");
            return target.put(...args);
          };
        const value = Reflect.get(target, name, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racer = new EffectRunner({
      db,
      owner: "report-builder-race",
      log,
      handlers: [createReportBuilderConsumer({ db, storage: racing, log })],
    });
    expect(await racer.run(effect)).toBe("completed");
    expect((await row(job.id)).status).toBe("failed");
    expect(await storage.head("reports", reportArtifactKey(job.id))).toBeNull();
  });
});
