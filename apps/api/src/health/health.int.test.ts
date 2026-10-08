import "reflect-metadata";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);

describe("readiness against real infrastructure", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await createApp({
      NODE_ENV: "test",
      APP_ENV: "test",
      API_HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
      API_PORT: 0,
      DATABASE_URL: DATABASE_TEST_URL,
      DATABASE_POOL_MAX: 2,
      QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
    });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  it("reports ok when PostgreSQL and queue Redis are up", async () => {
    const res = await fetch(`${base}/v1/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checks: { database: "up", queue: "up" } });
  });
});
