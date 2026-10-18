import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { internalOpsResponseSchema } from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { signServiceRequest, type ServiceKey } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-ops-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const PATH = "/v1/internal/ops";
const secret = () => randomBytes(32).toString("base64url");
const worker: ServiceKey = { service: "worker", keyId: "k1", secret: secret() };
const storefront: ServiceKey = { service: "storefront", keyId: "k1", secret: secret() };
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  INTERNAL_SERVICE_KEYS: [worker, storefront]
    .map((key) => `${key.service}:${key.keyId}:${key.secret}`)
    .join(","),
});
let app: INestApplication;
let base: string;
const ops = (key: ServiceKey | null) =>
  fetch(base + PATH, {
    headers: key ? signServiceRequest(key, { method: "GET", path: PATH, body: "" }) : {},
  });

describe("internal ops signals for the worker's monitor (step 125)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("answers the worker with counts and readiness, and refuses anyone else", async () => {
    const before = internalOpsResponseSchema.parse(await (await ops(worker)).json());
    expect(before.readiness.status).toBe("ok");
    expect(before.checkout).toMatchObject({ requests: 0, serverErrors: 0, windowSeconds: 600 });
    // Quote attempts are counted (refused here: no age ticket, a 4xx, not a server error).
    for (let i = 0; i < 3; i++) {
      const response = await fetch(base + "/v1/store/cart/quote", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ih-client-ip": "192.0.2.9" },
        body: JSON.stringify({ lines: [] }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    // While checkout is closed the order route's deliberate 503 is not counted.
    await fetch(base + "/v1/store/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ih-client-ip": "192.0.2.9" },
      body: "{}",
    });
    const response = await ops(worker);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const after = internalOpsResponseSchema.parse(await response.json());
    expect(after.checkout).toMatchObject({ requests: 3, serverErrors: 0 });

    expect((await ops(null)).status).toBe(401);
    expect((await ops(storefront)).status).toBe(401);
  });
});
