import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiEnvSchema } from "@ih/config";
import { createApp } from "../bootstrap";

// Unreachable dependencies on purpose: liveness must not depend on them, readiness must report them.
// Parsed so newly added optional settings (storage, internal auth) take their defaults.
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  API_HOST: "127.0.0.1",
  LOG_LEVEL: "silent",
  API_PORT: 4000, // unused: tests listen on an ephemeral port
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
  DATABASE_POOL_MAX: 1,
  QUEUE_REDIS_URL: "redis://127.0.0.1:1",
});

describe("health endpoints", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await createApp(env);
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  it("live responds without touching dependencies", async () => {
    const res = await fetch(`${base}/v1/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("ready returns 503 when the database is down", async () => {
    const res = await fetch(`${base}/v1/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "down",
      checks: { database: "down", queue: "down" },
    });
  });

  it("rejects malformed inbound request ids", async () => {
    const res = await fetch(`${base}/v1/health/live`, { headers: { "x-request-id": "<script>" } });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-request-id")).not.toBe("<script>");
  });
});
