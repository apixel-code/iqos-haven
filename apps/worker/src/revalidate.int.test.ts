import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent, internalRevalidateRequestSchema } from "@ih/contracts";
import { createDatabase, createPool, PrismaOutboxWriter, withTransaction } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { InMemoryNonceStore, verifyServiceRequest, type ServiceKey } from "@ih/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import type { EffectJobData } from "./queues";
import { createRevalidateConsumer, revalidateTargetFromEnv } from "./revalidate";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-revalidate-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "revalidate-test", level: "silent" });
const writer = new PrismaOutboxWriter();
const key: ServiceKey = {
  service: "worker",
  keyId: "k1",
  secret: randomBytes(32).toString("base64url"),
};

/** Stand-in for the private API route: verifies the real signature, then answers `status`. */
const nonces = new InMemoryNonceStore();
const received: Array<{ auth: string; body: unknown }> = [];
let status = 204;
let server: Server;
let apiUrl = "";

async function publish(): Promise<{ eventId: string; data: EffectJobData }> {
  const productId = randomUUID();
  const eventId = await withTransaction(db, (tx) =>
    writer.publish(
      tx,
      defineEvent("catalog.changed", productId, { entityType: "product", entityId: productId }),
    ),
  );
  const effect = await db.consumerEffect.findFirstOrThrow({ where: { eventId } });
  return { eventId, data: { eventId, effectId: effect.id, consumer: "storefront_revalidate" } };
}
const runner = (target = { apiUrl, key }, maxless = false) =>
  new EffectRunner({
    db,
    owner: "revalidate-" + randomUUID().slice(0, 6),
    log,
    handlers: [createRevalidateConsumer({ target: maxless ? undefined : target, log })],
    defaultMaxAttempts: 2,
  });
const effectOf = (id: string) => db.consumerEffect.findUniqueOrThrow({ where: { id } });
const due = (id: string) =>
  pool.query("UPDATE consumer_effects SET due_at = now() WHERE id = $1", [id]);

describe("storefront_revalidate consumer (real PostgreSQL, signed HTTP)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        void verifyServiceRequest(
          { method: request.method!, path: request.url!, body, headers: request.headers },
          { keys: [key], allowedServices: ["worker"], nonces },
        ).then((result) => {
          received.push({
            auth: result.ok ? "ok" : result.reason,
            body: JSON.parse(body.toString("utf8")),
          });
          response.writeHead(result.ok ? status : 401).end();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("snapshots the consumer on catalog.changed and completes after a signed call", async () => {
    const { eventId, data } = await publish();
    received.length = 0;
    expect(await runner().run(data)).toBe("completed");
    expect(received).toEqual([{ auth: "ok", body: { scope: "catalogue", eventId } }]);
    expect(internalRevalidateRequestSchema.safeParse(received[0]!.body).success).toBe(true);
    expect(await effectOf(data.effectId)).toMatchObject({
      status: "completed",
      externalReceipt: "invalidated:204",
    });
    const event = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.completedAt).not.toBeNull();
    // Redelivery after completion claims nothing and sends nothing.
    expect(await runner().run(data)).toBe("duplicate");
    expect(received).toHaveLength(1);
  });

  it("retries an unavailable API and succeeds later", async () => {
    const { data } = await publish();
    status = 503;
    expect(await runner().run(data)).toBe("retry");
    expect(await effectOf(data.effectId)).toMatchObject({
      status: "retry",
      lastError: "TRANSIENT:REVALIDATE_HTTP_503",
    });
    status = 204;
    await due(data.effectId);
    expect(await runner().run(data)).toBe("completed");
  });

  it("retries an unreachable API or rejected key, then goes dead for investigation", async () => {
    const unreachable = await publish();
    const closed = runner({ apiUrl: "http://127.0.0.1:1", key });
    expect(await closed.run(unreachable.data)).toBe("retry");
    expect((await effectOf(unreachable.data.effectId)).lastError).toBe(
      "TRANSIENT:REVALIDATE_UNREACHABLE",
    );
    const rejected = await publish();
    const wrongKey = runner({
      apiUrl,
      key: { ...key, secret: randomBytes(32).toString("base64url") },
    });
    expect(await wrongKey.run(rejected.data)).toBe("retry");
    await due(rejected.data.effectId);
    expect(await wrongKey.run(rejected.data)).toBe("dead");
    expect(await effectOf(rejected.data.effectId)).toMatchObject({
      status: "dead",
      lastError: "RETRY_EXHAUSTED:TRANSIENT:REVALIDATE_HTTP_401",
    });
  });

  it("completes as skipped when no target is configured (local development)", async () => {
    const { data } = await publish();
    received.length = 0;
    expect(await runner(undefined, true).run(data)).toBe("completed");
    expect(received).toEqual([]);
    expect((await effectOf(data.effectId)).externalReceipt).toBe("skipped:not_configured");
    expect(revalidateTargetFromEnv({ API_INTERNAL_URL: apiUrl })).toBeUndefined();
    expect(
      revalidateTargetFromEnv({
        API_INTERNAL_URL: apiUrl,
        INTERNAL_SERVICE_ID: key.service,
        INTERNAL_SERVICE_KEY_ID: key.keyId,
        INTERNAL_SERVICE_KEY: key.secret,
      }),
    ).toEqual({ apiUrl, key });
  });
});
