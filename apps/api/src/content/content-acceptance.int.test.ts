import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  adminContentSectionSchema,
  errorEnvelopeSchema,
  storeHomeResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool, publishContentSection, saveContentDraft } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import {
  AGE_COOKIE,
  ageTicketPublicKey,
  ageTicketSigner,
  Argon2PasswordHasher,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

/**
 * Content acceptance (roadmap step 102, M9 gate evidence): two editors, a refused publish that
 * leaves the live copy alone, propagation through the cache (immediate on this replica, within
 * the TTL elsewhere), and a cache warmed by a verified shopper that never answers an
 * unverified one. The cache TTL is 1 s here so the bound can be observed.
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-content-acceptance-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const POLICY = "content-acceptance-1";
const PASSWORD = "copper-lantern-river-71";
const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
  CATALOG_CACHE_TTL_SECONDS: "1",
});
const ageCookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base = "";
const editors: Array<{ id: string; cookie: string }> = [];
let host = 10;
const ip = () => `192.0.2.${(host = (host % 240) + 1)}`;
const admin = (path: string, method: string, body: unknown, cookie: string) =>
  fetch(`${base}/v1/admin/content${path}`, {
    method,
    headers: { cookie, origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": ip() },
    body: JSON.stringify(body),
  });
const home = (cookie?: string) =>
  fetch(`${base}/v1/store/content/home`, {
    headers: { "x-ih-client-ip": ip(), ...(cookie ? { cookie } : {}) },
  });
const homeData = async () => storeHomeResponseSchema.parse(await (await home(ageCookie)).json());
const code = async (response: Response) =>
  errorEnvelopeSchema.parse(await response.json()).error.code;
const ticker = (messages: string[]) => ({ enabled: true, messages });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("content acceptance (real API, PostgreSQL, cache)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    for (const name of ["first", "second"]) {
      const email = `editor-${name}@iqoshaven.test`;
      const user = await db.staffUser.create({
        data: {
          email,
          name: "Editor " + name,
          roleId: role.id,
          passwordHash: await hasher.hash(PASSWORD),
        },
      });
      const response = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: {
          origin: ADMIN,
          "content-type": "application/json",
          "x-ih-client-ip": "192.0.2.250",
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      editors.push({ id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0]! });
    }
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("two editors on the same version: one save wins, the other must reload; publish too", async () => {
    const [a, b] = [editors[0]!, editors[1]!];
    const first = await admin(
      "/ticker/draft",
      "PUT",
      { expectedVersion: 0, content: ticker(["One", "Two"]) },
      a.cookie,
    );
    expect(first.status).toBe(200);
    // Both open version 1 and save at once.
    const saves = await Promise.all([
      admin(
        "/ticker/draft",
        "PUT",
        { expectedVersion: 1, content: ticker(["From A", "Two"]) },
        a.cookie,
      ),
      admin(
        "/ticker/draft",
        "PUT",
        { expectedVersion: 1, content: ticker(["From B", "Two"]) },
        b.cookie,
      ),
    ]);
    expect(saves.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = saves.find((response) => response.status === 409)!;
    expect(await code(loser)).toBe("VERSION_CONFLICT");
    // The stale editor cannot publish what the other one saved without reloading.
    expect(
      await code(await admin("/ticker/publish", "POST", { expectedVersion: 1 }, b.cookie)),
    ).toBe("VERSION_CONFLICT");
    const published = await admin("/ticker/publish", "POST", { expectedVersion: 2 }, b.cookie);
    expect(published.status).toBe(200);
    expect(adminContentSectionSchema.parse(await published.json()).version).toBe(3);
    // Each change is audited once, by the editor who made it.
    const audits = await pool.query(
      "SELECT action, actor_id FROM audit_log WHERE entity_type='content_section' ORDER BY occurred_at",
    );
    expect(audits.rows.map((row: { action: string }) => row.action)).toEqual([
      "content.draft_saved",
      "content.draft_saved",
      "content.published",
    ]);
  });

  it("a refused publish leaves the live copy as it was", async () => {
    const { variantId } = await seedOrder(pool);
    const hidden = await pool.query("SELECT product_id AS id FROM variants WHERE id=$1", [
      variantId,
    ]);
    const owner = editors[0]!;
    const before = await homeData();
    const current = await pool.query("SELECT version FROM content_sections WHERE key='ticker'");
    // The live ticker stays; an offers draft pointing at a draft product cannot go live.
    const saved = await admin(
      "/offers/draft",
      "PUT",
      {
        expectedVersion: 0,
        content: { enabled: true, title: "Offers", productIds: [hidden.rows[0].id] },
      },
      owner.cookie,
    );
    expect(saved.status).toBe(200);
    expect(
      await code(await admin("/offers/publish", "POST", { expectedVersion: 1 }, owner.cookie)),
    ).toBe("CONTENT_REFERENCES");
    await sleep(1100);
    const after = await homeData();
    expect(after.offers).toBeNull();
    expect(after.ticker).toEqual(before.ticker);
    expect(current.rows[0].version).toBe(3);
  });

  it("propagates at once through the routes, and within the TTL when no event arrives", async () => {
    const owner = editors[0]!;
    // Through the admin route: this replica drops its cache after the commit.
    const saved = adminContentSectionSchema.parse(
      await (
        await admin(
          "/ticker/draft",
          "PUT",
          { expectedVersion: 3, content: ticker(["Route update", "Two"]) },
          owner.cookie,
        )
      ).json(),
    );
    await admin("/ticker/publish", "POST", { expectedVersion: saved.version }, owner.cookie);
    expect((await homeData()).ticker?.messages).toEqual(["Route update", "Two"]);
    // Written without the routes (as another replica would): nothing drops this cache, so the
    // old answer may stay, but never longer than the TTL (1 s here, at most 60 s in production).
    await homeData(); // warm
    const row = await pool.query("SELECT version FROM content_sections WHERE key='ticker'");
    const next = await saveContentDraft(
      db,
      { requestId: randomUUID(), actorId: owner.id },
      "ticker",
      {
        expectedVersion: row.rows[0].version,
        content: ticker(["Other replica", "Two"]),
      },
    );
    await publishContentSection(
      db,
      { requestId: randomUUID(), actorId: owner.id },
      "ticker",
      next.version,
    );
    await sleep(1200);
    expect((await homeData()).ticker?.messages).toEqual(["Other replica", "Two"]);
    // The publish wrote its invalidation event for every other replica (the worker's
    // storefront_revalidate effect; its retry is covered in apps/worker/src/revalidate.int.test.ts).
    const effects = await db.consumerEffect.findMany({
      where: { consumer: "storefront_revalidate", event: { eventType: "content.published" } },
    });
    expect(effects.length).toBeGreaterThanOrEqual(3);
  });

  it("a cache warmed by a verified shopper never answers an unverified one", async () => {
    const warm = await home(ageCookie);
    expect(warm.status).toBe(200);
    for (const cookie of [undefined, `${AGE_COOKIE}=accepted`]) {
      const response = await home(cookie);
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain("Other replica");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
