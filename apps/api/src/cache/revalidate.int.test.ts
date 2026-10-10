import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { Argon2PasswordHasher, signServiceRequest, type ServiceKey } from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CatalogueCacheService } from "./catalogue-cache.service";

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
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const PATH = "/v1/internal/revalidate";
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
  CATALOG_CACHE_MAX_ENTRIES: 3,
});

let app: INestApplication;
let base: string;
let cache: CatalogueCacheService;
let cookie = "";
let loads = 0;
/** Stands in for a store catalogue read (step 58): each database miss returns a new value. */
const read = () => cache.getOrLoad("probe", () => Promise.resolve({ load: ++loads }));

function revalidate(key: ServiceKey | null, payload: unknown = { scope: "catalogue" }) {
  const body = JSON.stringify(
    payload && typeof payload === "object" && "scope" in payload
      ? { eventId: randomUUID(), ...payload }
      : payload,
  );
  return fetch(base + PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? signServiceRequest(key, { method: "POST", path: PATH, body }) : {}),
    },
    body,
  });
}
const brand = (headers: Record<string, string>, name = "Brand " + randomUUID().slice(0, 8)) =>
  fetch(`${base}/v1/admin/brands`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ih-client-ip": "192.0.2.2", ...headers },
    body: JSON.stringify({ name, slug: "b-" + randomUUID().slice(0, 8), active: true }),
  });

describe("catalogue cache owner and private invalidation (real API)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    const staff = await db.staffUser.create({
      data: {
        email: "cache@iqoshaven.test",
        name: "Cache Person",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cache = app.get(CatalogueCacheService);
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
      body: JSON.stringify({ email: staff.email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("serves repeated reads from memory within the configured entry budget", async () => {
    const first = await read();
    expect(await read()).toEqual(first);
    for (let index = 0; index < 10; index++)
      await cache.getOrLoad("fill-" + index, () => Promise.resolve("x"));
    expect(cache.stats().entries).toBe(3);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it("drops the cache for a signed worker call, and is safe to repeat", async () => {
    const before = await read();
    const response = await revalidate(worker);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await read()).not.toEqual(before);
    expect((await revalidate(worker)).status).toBe(204);
    expect(cache.stats().lastInvalidatedAt).toBeGreaterThan(0);
  });

  it("refuses unsigned, cookie-authenticated and non-worker callers without invalidating", async () => {
    const before = await read();
    expect((await revalidate(null)).status).toBe(401);
    expect((await revalidate(storefront)).status).toBe(401);
    const withCookie = await fetch(base + PATH, {
      method: "POST",
      headers: { cookie, origin: ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ scope: "catalogue", eventId: randomUUID() }),
    });
    expect(withCookie.status).toBe(401);
    // A captured request cannot be replayed.
    const body = JSON.stringify({ scope: "catalogue", eventId: randomUUID() });
    const signed = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signServiceRequest(worker, { method: "POST", path: PATH, body }),
      },
      body,
    };
    expect(await read()).toEqual(before);
    expect((await fetch(base + PATH, signed)).status).toBe(204);
    expect((await fetch(base + PATH, signed)).status).toBe(401);
  });

  it("rejects an invalid body from a valid caller", async () => {
    const before = await read();
    expect((await revalidate(worker, { scope: "everything" })).status).toBe(400);
    expect((await revalidate(worker, { scope: "catalogue", eventId: "nope" })).status).toBe(400);
    expect((await revalidate(worker, { scope: "catalogue", extra: true })).status).toBe(400);
    expect(await read()).toEqual(before);
  });

  it("invalidates locally after a committed admin catalogue change, not on reads or denials", async () => {
    const before = await read();
    const list = await fetch(`${base}/v1/admin/brands`, {
      headers: { cookie, "x-ih-client-ip": "192.0.2.2" },
    });
    expect(list.status).toBe(200);
    expect((await brand({ origin: ADMIN })).status).toBe(401);
    expect(await read()).toEqual(before);
    const created = await brand({ cookie, origin: ADMIN });
    expect(created.status).toBe(201);
    const after = await read();
    expect(after).not.toEqual(before);
    // The same commit also queued the durable retry of this invalidation.
    const { id } = (await created.json()) as { id: string };
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: id, eventType: "catalog.changed" },
      include: { effects: true },
    });
    expect(event.effects.map((effect) => effect.consumer)).toEqual(["storefront_revalidate"]);
  });
});
