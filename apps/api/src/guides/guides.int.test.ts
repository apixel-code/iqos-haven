import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import type { GuideResponse, StoreGuideResponse, StoreGuidesResponse } from "@ih/contracts";
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

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-guides-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const POLICY = "guides-test-1";
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
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
});
const shopper = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base: string;
let seq = 0;
let ip = 10;
const cookies: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function user(roleKey: "owner" | "staff") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  return db.staffUser.create({
    data: {
      email: `guides${seq++}@iqoshaven.test`,
      name: "Test Person",
      roleId: role.id,
      passwordHash: await hasher.hash(PASSWORD),
    },
  });
}
async function login(email: string) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { origin: ADMIN, "content-type": "application/json", "x-ih-client-ip": "192.0.2.1" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (path: string, method = "GET", body?: unknown, cookie = cookies.owner) =>
  fetch(`${base}/v1/admin/guides${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": "192.0.2.2",
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** A fresh client address per call keeps the per-address limiter out of the way. */
const store = (path: string, cookie: string | null = shopper) =>
  fetch(`${base}/v1/store/guides${path}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      "x-ih-client-ip": `198.51.100.${(ip = (ip % 250) + 1)}`,
    },
  });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const slug = () => "guide-" + randomUUID().slice(0, 8);
const draft = (overrides: Record<string, unknown> = {}) => ({
  slug: slug(),
  title: "TEREA Japan: every flavour",
  summary: "What each TEREA Japan flavour tastes like, and which device to use.",
  body: "## Menthol\n\nTEREA **Black Menthol** is the strongest. See [all sticks](/sticks).",
  published: false,
  ...overrides,
});
async function create(overrides: Record<string, unknown> = {}) {
  const response = await call("", "POST", draft(overrides));
  expect(response.status).toBe(201);
  return (await response.json()) as GuideResponse;
}
const editable = (guide: GuideResponse) => ({
  version: guide.version,
  slug: guide.slug,
  title: guide.title,
  summary: guide.summary,
  body: guide.body,
  published: guide.published,
});

describe("guides through the real API and PostgreSQL (ADR 0117)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const owner = await user("owner");
    const staff = await user("staff");
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    cookies.owner = await login(owner.email);
    cookies.staff = await login(staff.email);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("lets the Owner write and publish a guide, with atomic audit and event", async () => {
    const guide = await create();
    expect(guide).toMatchObject({ published: false, publishedAt: null, version: 1 });
    const published = await call("/" + guide.id, "PATCH", { ...editable(guide), published: true });
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toBe("no-store");
    const after = (await published.json()) as GuideResponse;
    expect(after).toMatchObject({ published: true, version: 2 });
    expect(after.publishedAt).not.toBeNull();
    // Hiding it keeps the first publish date; publishing again does not move it.
    const hidden = (await (
      await call("/" + guide.id, "PATCH", { ...editable(after), published: false })
    ).json()) as GuideResponse;
    expect(hidden.publishedAt).toBe(after.publishedAt);
    const audit = await db.auditLog.findMany({
      where: { entityId: guide.id },
      orderBy: { id: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "guide.updated",
      "guide.updated",
      "guide.updated",
    ]);
    // The audit keeps facts, not the whole text.
    expect(JSON.stringify(audit.at(-1)!.diff)).not.toContain("Black Menthol");
    const events = await db.outboxEvent.findMany({ where: { aggregateId: guide.id } });
    expect(events.map((event) => [event.eventType, event.payload])).toEqual([
      ["guide.updated", { guideId: guide.id }],
      ["guide.updated", { guideId: guide.id }],
      ["guide.updated", { guideId: guide.id }],
    ]);
  });

  it("refuses Staff, signed-out callers, bad input, stale versions and a moved published link", async () => {
    expect((await call("", "GET", undefined, cookies.staff)).status).toBe(403);
    expect((await call("", "POST", draft(), cookies.staff)).status).toBe(403);
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    for (const body of [
      draft({ body: "<b>bold</b>" }),
      draft({ body: "Go [here](https://example.com)." }),
      draft({ slug: "Bad Slug" }),
      draft({ title: "" }),
      { ...draft(), extra: true },
    ])
      expect((await call("", "POST", body)).status).toBe(400);
    const taken = await create();
    const duplicate = await call("", "POST", draft({ slug: taken.slug }));
    expect(duplicate.status).toBe(409);
    expect(await code(duplicate)).toBe("DUPLICATE");
    const stale = await call("/" + taken.id, "PATCH", { ...editable(taken), version: 9 });
    expect(await code(stale)).toBe("VERSION_CONFLICT");
    // A draft may still change its link; a guide that has been published may not.
    const moved = (await (
      await call("/" + taken.id, "PATCH", { ...editable(taken), slug: slug(), published: true })
    ).json()) as GuideResponse;
    expect(moved.published).toBe(true);
    const locked = await call("/" + taken.id, "PATCH", { ...editable(moved), slug: slug() });
    expect(locked.status).toBe(409);
    expect(await code(locked)).toBe("GUIDE_SLUG_LOCKED");
    expect((await call("/" + randomUUID())).status).toBe(404);
    // Nothing deletes a guide: there is no route, and the runtime role may not.
    expect((await call("/" + taken.id, "DELETE")).status).not.toBe(200);
    expect(await db.guide.count({ where: { id: taken.id } })).toBe(1);
  });

  it("shows only published guides to a verified shopper, and nothing without the age ticket", async () => {
    const shown = await create({ published: true, title: "Shown guide" });
    const hidden = await create({ title: "Hidden guide" });
    const list = await store("");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toMatch(/private, no-store/);
    const items = ((await list.json()) as StoreGuidesResponse).items;
    expect(items.map((item) => item.slug)).toContain(shown.slug);
    expect(items.map((item) => item.slug)).not.toContain(hidden.slug);
    const page = await store("/" + shown.slug);
    expect(page.status).toBe(200);
    const read = (await page.json()) as StoreGuideResponse;
    expect(read).toMatchObject({ slug: shown.slug, title: "Shown guide", body: shown.body });
    expect(read).not.toHaveProperty("id");
    // A hidden guide is answered like one that does not exist.
    expect((await store("/" + hidden.slug)).status).toBe(404);
    expect((await store("/never-written")).status).toBe(404);
    expect((await store("/Not_A_Slug")).status).toBe(400);
    for (const path of ["", "/" + shown.slug]) {
      const unverified = await store(path, null);
      expect(unverified.status).toBe(403);
      expect(await unverified.text()).not.toContain("Shown guide");
    }
  });
});
