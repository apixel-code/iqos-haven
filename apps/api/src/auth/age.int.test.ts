import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { AGE_VERIFICATION_REQUIRED } from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import {
  AGE_COOKIE,
  Argon2PasswordHasher,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
  type AgeTicketSigner,
} from "@ih/platform";
import { Controller, Get, Module, Req, type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../bootstrap";
import { AgeVerified, type AgeVerifiedRequest } from "./access";
import { Serialize } from "./serialize";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-age-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const POLICY = "qa-policy-1";
const DAY = 24 * 60 * 60;

function newSigner(kid: string): AgeTicketSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return ageTicketSigner(kid, seed.toString("base64url"));
}
const current = newSigner("k2");
const previous = newSigner("k1");
const retired = newSigner("k0");
const baseEnv = {
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  AGE_POLICY_VERSION: POLICY,
};
const env = apiEnvSchema.parse({
  ...baseEnv,
  AGE_TICKET_PUBLIC_KEYS: [current, previous]
    .map((signer) => `${signer.kid}:${ageTicketPublicKey(signer)}`)
    .join(","),
});

/** Stands in for a store catalogue route (step 58): product data behind the age gate. */
@Controller({ path: "store/probe", version: "1" })
class StoreProbeController {
  @Get("product")
  @AgeVerified()
  @Serialize(z.strictObject({ name: z.string(), priceFils: z.number().int(), policy: z.string() }))
  product(@Req() request: AgeVerifiedRequest) {
    return {
      name: "Restricted product",
      priceFils: 4900,
      policy: request.ageTicket!.policyVersion,
    };
  }
}
@Module({ controllers: [StoreProbeController] })
class StoreProbeModule {}

let app: INestApplication;
let base: string;
const ticket = (
  signer = current,
  overrides: { policyVersion?: string; ttlSeconds?: number; now?: number } = {},
) => signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 30 * DAY, ...overrides }).ticket;
const get = (headers: Record<string, string> = {}, url = base) =>
  fetch(`${url}/v1/store/probe/product`, { headers });
const withTicket = (value: string) => get({ cookie: `${AGE_COOKIE}=${value}` });
async function refused(response: Response) {
  const text = await response.text();
  expect(response.status).toBe(403);
  expect(JSON.parse(text).error.code).toBe(AGE_VERIFICATION_REQUIRED);
  // Nothing about the product leaves the API without a valid ticket. The random request ID is
  // left out of the check: it can contain "4900" by chance.
  const { requestId: _id, ...error } = JSON.parse(text).error as Record<string, unknown>;
  const shown = JSON.stringify(error);
  expect(shown).not.toContain("Restricted product");
  expect(shown).not.toContain("4900");
  expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("API age gate (real API, Ed25519 tickets)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    app = await createApp(env, { pool, database: db }, [StoreProbeModule]);
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("serves product data only with a valid ticket", async () => {
    await refused(await get());
    const response = await withTicket(ticket());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "Restricted product",
      priceFils: 4900,
      policy: POLICY,
    });
  });

  it("accepts the previous key during rotation and refuses a retired or unknown one", async () => {
    expect((await withTicket(ticket(previous))).status).toBe(200);
    await refused(await withTicket(ticket(retired)));
    await refused(await withTicket(ticket(newSigner("k2"))));
  });

  it("refuses expired, future-dated, tampered, re-policied and malformed tickets", async () => {
    const past = Date.now() - 31 * DAY * 1000;
    await refused(await withTicket(ticket(current, { now: past })));
    await refused(await withTicket(ticket(current, { ttlSeconds: 60, now: Date.now() - 120_000 })));
    await refused(await withTicket(ticket(current, { now: Date.now() + 10 * 60_000 })));
    await refused(await withTicket(ticket(current, { policyVersion: "older-policy" })));
    const good = ticket();
    await refused(await withTicket(good.slice(0, -3) + "AAA"));
    await refused(await withTicket(good.replace("v1.k2.", "v1.k1.")));
    for (const junk of ["true", "accepted", "v1.k2..", "x".repeat(600), "1"])
      await refused(await withTicket(junk));
  });

  it("has no bypass: crawler user agents, headers, query flags, admin sessions, planted cookies", async () => {
    for (const agent of [
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "facebookexternalhit/1.1",
      "Twitterbot/1.0",
    ])
      await refused(await get({ "user-agent": agent }));
    await refused(
      await get({ "x-age-verified": "true", "x-ih-age": "accepted", authorization: "Bearer x" }),
    );
    await refused(await fetch(`${base}/v1/store/probe/product?age=accepted&ih_age=${ticket()}`));
    // A signed-in Owner is not an age-verified shopper.
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    await db.staffUser.create({
      data: {
        email: "age-owner@iqoshaven.test",
        name: "Owner",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
      body: JSON.stringify({ email: "age-owner@iqoshaven.test", password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const session = login.headers.get("set-cookie")!.split(";")[0]!;
    await refused(await get({ cookie: session }));
    // A second, different ih_age cookie next to a valid one is refused, in either order.
    const good = ticket();
    await refused(await get({ cookie: `${AGE_COOKIE}=${good}; ${AGE_COOKIE}=forged` }));
    await refused(await get({ cookie: `${AGE_COOKIE}=forged; ${AGE_COOKIE}=${good}` }));
    expect((await get({ cookie: `${session}; ${AGE_COOKIE}=${good}` })).status).toBe(200);
  });

  it("never lets a shopper's age ticket stand in for a staff session (step 118)", async () => {
    const good = ticket();
    for (const path of [
      "/v1/auth/me",
      "/v1/admin/dashboard",
      "/v1/admin/orders",
      "/v1/admin/customers",
      "/v1/admin/reports",
      "/v1/admin/events/stream",
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { cookie: `${AGE_COOKIE}=${good}`, origin: ADMIN, "x-ih-client-ip": "192.0.2.9" },
      });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }
  });

  it("fails closed when no verification key is configured", async () => {
    const closed = await createApp(
      apiEnvSchema.parse({ ...baseEnv, AGE_TICKET_PUBLIC_KEYS: "" }),
      { pool, database: db },
      [StoreProbeModule],
    );
    await closed.listen(0, "127.0.0.1");
    try {
      await refused(await withTicketAt(await closed.getUrl(), ticket()));
    } finally {
      await closed.close();
    }
  });
});

const withTicketAt = (url: string, value: string) => get({ cookie: `${AGE_COOKIE}=${value}` }, url);
