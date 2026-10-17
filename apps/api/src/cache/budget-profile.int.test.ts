import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import {
  AGE_COOKIE,
  Argon2PasswordHasher,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";
import { CatalogueCacheService } from "./catalogue-cache.service";

/**
 * The selected launch profile (roadmap step 119, BI-06: one Hostinger VPS, budget profile):
 * the API runs with no cache Redis, owns a bounded in-process catalogue cache and the local
 * limiters. Checked against the real API and PostgreSQL with the production profile settings
 * (only the TTL is shortened so recovery can be observed).
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-budget-profile-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const POLICY = "budget-1";
const ADMIN = "http://localhost:8081";
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
/** Production-profile settings: budget, one process, no cache Redis, default budgets. */
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
  RATE_LIMIT_PROFILE: "budget",
  RATE_LIMIT_MAX_REPLICAS: "1",
  CATALOG_CACHE_TTL_SECONDS: "1",
});
const cookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;
let host = 10;
let slug = "";
let productId = "";
const read = (base: string, ip = `198.51.100.${(host = (host % 240) + 1)}`) =>
  fetch(`${base}/v1/store/products/${slug}`, { headers: { cookie, "x-ih-client-ip": ip } });
const nameOn = async (base: string) => ((await (await read(base)).json()) as { name: string }).name;
/** A change made outside the API (a migration, an operator): no invalidation is sent. */
const renameBehindTheCache = (name: string) =>
  pool.query("UPDATE products SET name=$1, version=version+1 WHERE id=$2", [name, productId]);

async function start() {
  const app = await createApp(env, { pool, database: db });
  await app.listen(0, "127.0.0.1");
  return { app, base: await app.getUrl() };
}

describe("budget launch profile: in-process cache and local limiters (real API and PostgreSQL)", () => {
  let first: { app: INestApplication; base: string };
  beforeAll(async () => {
    expect(env.CACHE_REDIS_URL).toBeUndefined();
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    await db.staffUser.create({
      data: {
        email: "budget-owner@iqoshaven.test",
        name: "Budget Owner",
        roleId: role.id,
        passwordHash: await new Argon2PasswordHasher({
          memoryKib: 19456,
          timeCost: 2,
          parallelism: 1,
        }).hash("copper-lantern-river-71"),
      },
    });
    const brand = await db.brand.create({
      data: { name: "Budget brand", slug: "budget-brand", active: true },
    });
    const category = await db.category.create({
      data: { name: "Budget category", slug: "budget-category", active: true },
    });
    slug = "budget-kit";
    productId = (
      await db.product.create({
        data: {
          name: "Budget Kit",
          slug,
          brandId: brand.id,
          categoryId: category.id,
          type: "kit",
          basePriceFils: 5000n,
          description: "Synthetic description.",
          specs: { extra: [] },
          status: "draft",
        },
      })
    ).id;
    const variant = await db.variant.create({
      data: { productId, sku: "BUDGET-1", active: true, isDefault: true },
    });
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 5, 5, 'INITIAL_STOCK', $2)",
      [variant.id, randomUUID()],
    );
    await db.product.update({
      where: { id: productId },
      data: { status: "published", taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 },
    });
    first = await start();
  });
  afterAll(async () => {
    await first?.app.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("uses the local cache, which recovers by its TTL when no invalidation ever comes", async () => {
    const cache = first.app.get(CatalogueCacheService);
    expect(cache.constructor.name).toBe("CatalogueCacheService");
    expect(await nameOn(first.base)).toBe("Budget Kit");
    await renameBehindTheCache("Budget Kit Renamed");
    // Served from memory within the TTL (the bounded staleness the profile accepts)…
    expect(await nameOn(first.base)).toBe("Budget Kit");
    // …and fresh once it has passed, without any signal.
    await delay(1300);
    expect(await nameOn(first.base)).toBe("Budget Kit Renamed");
  });

  it("starts empty after a restart and serves the current data", async () => {
    await renameBehindTheCache("Budget Kit After Restart");
    await first.app.close();
    first = await start();
    expect(await nameOn(first.base)).toBe("Budget Kit After Restart");
  });

  it("limits a burst with the local limiter alone, answering 429 with Retry-After", async () => {
    // One address above the store catalogue budget (240 a minute): the rest are refused.
    const ip = "203.0.113.50";
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 250; i++) {
      const response = await read(first.base, ip);
      statuses.push(response.status);
      if (response.status === 429) retryAfter = response.headers.get("retry-after");
      await response.arrayBuffer();
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(240);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // Another address is untouched.
    expect((await read(first.base, "203.0.113.51")).status).toBe(200);
  });

  it("keeps the strict sign-in limit authoritative without any Redis", async () => {
    const attempt = () =>
      fetch(`${first.base}/v1/auth/login`, {
        method: "POST",
        headers: {
          origin: ADMIN,
          "content-type": "application/json",
          "x-ih-client-ip": "203.0.113.60",
        },
        body: JSON.stringify({
          email: "budget-owner@iqoshaven.test",
          password: "wrong-password-123456",
        }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt()).status);
    // Ten tries per identity from one network, then refused, whatever the password.
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
