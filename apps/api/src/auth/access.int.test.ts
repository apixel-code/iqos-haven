import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  type ApiEnv,
} from "@ih/config";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { defineFieldPolicy, type PermissionKey } from "@ih/domain";
import { Argon2PasswordHasher } from "@ih/platform";
import { Body, Controller, Get, Module, Post, type INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../bootstrap";
import { createZodDto } from "../http/zod-validation.pipe";
import { Authenticated, Public, RequirePermission } from "./access";
import { InternalService } from "../internal/service-auth.guard";
import { NoResponseBody, Serialize } from "./serialize";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-access-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const fast = { memoryKib: 19_456, timeCost: 2, parallelism: 1 };
const hasher = new Argon2PasswordHasher(fast);
const PASSWORD = "copper-lantern-river-71";
const ADMIN_ORIGIN = "http://localhost:8081";

// Probe routes stand in for the admin endpoints that later steps add with the same decorators.
const customerSchema = z.strictObject({
  id: z.string(),
  phone: z.string(),
  lifetimeSpendFils: z.number().int().optional(),
  orders: z.array(
    z.strictObject({
      id: z.string(),
      totalFils: z.number().int(),
      revenueFils: z.number().int().optional(),
    }),
  ),
});
const customerFields = defineFieldPolicy({
  lifetimeSpendFils: "customers.financial_read",
  orders: { revenueFils: "dashboard.financial_read" },
});
class SettingsDto extends createZodDto(z.object({ storeName: z.string().min(1).max(40) })) {}

@Controller({ path: "admin/probe", version: "1" })
class ProbeController {
  @Get("customer")
  @RequirePermission("customers.read")
  @Serialize(customerSchema, customerFields)
  customer() {
    return {
      id: "c1",
      phone: "+971500000000",
      lifetimeSpendFils: 1_234_500,
      orders: [{ id: "o1", totalFils: 25_000, revenueFils: 20_000 }],
    };
  }

  @Post("settings")
  @RequirePermission("settings.manage")
  @Serialize(z.strictObject({ storeName: z.string() }))
  settings(@Body() body: SettingsDto) {
    return body;
  }

  @Get("export")
  @RequirePermission("customers.read", "customers.export")
  @Serialize(z.strictObject({ ok: z.literal(true) }))
  export() {
    return { ok: true };
  }

  @Post("ping")
  @Authenticated()
  @NoResponseBody()
  ping() {
    return { secret: "dropped" };
  }

  @Get("internal")
  @InternalService("worker")
  @Serialize(z.strictObject({ ok: z.literal(true) }))
  internal() {
    return { ok: true };
  }

  @Get("leak")
  @Authenticated()
  @Serialize(z.strictObject({ id: z.string() }))
  leak() {
    return { id: "c1", passwordHash: "$argon2id$secret" };
  }
}

/** Controller-level policy with a handler override. */
@RequirePermission("staff.manage")
@Controller({ path: "admin/probe-owner", version: "1" })
class OwnerProbeController {
  @Get()
  @Serialize(z.strictObject({ ok: z.literal(true) }))
  list() {
    return { ok: true };
  }

  /** Public handler in a protected controller: no caller, so every policy field is removed. */
  @Get("open")
  @Public()
  @Serialize(customerSchema, customerFields)
  open() {
    return {
      id: "c1",
      phone: "+971500000000",
      lifetimeSpendFils: 1_234_500,
      orders: [{ id: "o1", totalFils: 25_000, revenueFils: 20_000 }],
    };
  }
}

@Module({ controllers: [ProbeController, OwnerProbeController] })
class ProbeModule {}

@Controller({ path: "forgotten", version: "1" })
class UndeclaredController {
  @Get()
  forgotten() {
    return { leaked: true };
  }
}
@Module({ controllers: [UndeclaredController] })
class UndeclaredModule {}

@Public()
@Controller({ path: "class-public", version: "1" })
class ClassPublicController {
  @Get()
  later() {
    return { leaked: true };
  }
}
@Module({ controllers: [ClassPublicController] })
class ClassPublicModule {}

@Controller({ path: "unfiltered", version: "1" })
class UnfilteredController {
  @Get()
  @RequirePermission("customers.read")
  raw() {
    return { lifetimeSpendFils: 1 };
  }
}
@Module({ controllers: [UnfilteredController] })
class UnfilteredModule {}

let env: ApiEnv;
let app: INestApplication;
let base: string;
const tokens: Record<"owner" | "staff", string> = { owner: "", staff: "" };

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return /__Host-ih_admin=([A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie")!)![1]!;
}

const call = (path: string, token?: string, body?: unknown) =>
  fetch(`${base}/v1/${path.startsWith("auth/") ? path : "admin/" + path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { cookie: `__Host-ih_admin=${token}` } : {}),
      ...(body === undefined ? {} : { origin: ADMIN_ORIGIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("permission guard and response field filtering (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    env = apiEnvSchema.parse({
      NODE_ENV: "test",
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: DATABASE_TEST_URL,
      QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
      ARGON2_MEMORY_KIB: fast.memoryKib,
      ARGON2_TIME_COST: fast.timeCost,
      ARGON2_PARALLELISM: fast.parallelism,
    });
    app = await createApp(env, { pool, database: db }, [ProbeModule]);
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    for (const role of ["owner", "staff"] as const) {
      const roleRow = await db.role.findUniqueOrThrow({ where: { key: role } });
      await db.staffUser.create({
        data: {
          email: `${role}@iqoshaven.test`,
          name: "Test " + role,
          roleId: roleRow.id,
          passwordHash: await hasher.hash(PASSWORD),
        },
      });
      tokens[role] = await signIn(`${role}@iqoshaven.test`);
    }
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("refuses to start when a route could fail open", async () => {
    const cases = [
      [UndeclaredModule, /UndeclaredController\.forgotten: no access policy/],
      [ClassPublicModule, /ClassPublicController: @public must be declared per handler/],
      [UnfilteredModule, /UnfilteredController\.raw: signed-in route without @Serialize/],
    ] as const;
    for (const [module, message] of cases) {
      const broken = await createApp(env, { pool, database: db }, [module]);
      await expect(broken.init()).rejects.toThrow(message);
      await broken.close().catch(() => undefined);
    }
    await expect(
      createApp({ ...env, NODE_ENV: "production" }, { pool, database: db }, [ProbeModule]),
    ).rejects.toThrow(/not allowed in production/);
  });

  it("rejects unknown permissions when routes are declared", () => {
    expect(() => RequirePermission("orders.everything" as PermissionKey)).toThrow(/Unknown/);
    expect(() => Serialize(z.object({}), { total: "reports.everything" as PermissionKey })).toThrow(
      /Unknown/,
    );
  });

  it("requires a session before any permission check", async () => {
    for (const path of ["probe/customer", "probe/export", "probe-owner", "probe/leak"]) {
      const response = await call(path);
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("UNAUTHENTICATED");
    }
    expect((await call("probe/customer", "A".repeat(43))).status).toBe(401);
  });

  it("strips Owner-only aggregates for Staff and keeps them for the Owner", async () => {
    const owner = await call("probe/customer", tokens.owner);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      id: "c1",
      phone: "+971500000000",
      lifetimeSpendFils: 1_234_500,
      orders: [{ id: "o1", totalFils: 25_000, revenueFils: 20_000 }],
    });

    const staff = await call("probe/customer", tokens.staff);
    expect(staff.status).toBe(200);
    const text = await staff.text();
    expect(JSON.parse(text)).toEqual({
      id: "c1",
      phone: "+971500000000",
      orders: [{ id: "o1", totalFils: 25_000 }],
    });
    expect(text).not.toMatch(/lifetimeSpend|revenue|1234500|20000/);
  });

  it("denies Staff an Owner-only action even with a valid body, before validation", async () => {
    const owner = await call("probe/settings", tokens.owner, { storeName: "Iqos Haven" });
    expect(owner.status).toBe(201);
    expect(await owner.json()).toEqual({ storeName: "Iqos Haven" });

    for (const body of [{ storeName: "Iqos Haven" }, { storeName: "" }, { other: 1 }]) {
      const staff = await call("probe/settings", tokens.staff, body);
      expect(staff.status).toBe(403);
      expect(await errorCode(staff)).toBe("FORBIDDEN");
    }
  });

  it("rejects invalid input for an allowed role", async () => {
    for (const body of [
      { storeName: "" },
      { storeName: "x".repeat(41) },
      { storeName: "a", x: 1 },
    ]) {
      const response = await call("probe/settings", tokens.owner, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("VALIDATION_ERROR");
    }
  });

  it("requires every listed permission", async () => {
    expect((await call("probe/export", tokens.owner)).status).toBe(200);
    // Staff has customers.read but not customers.export.
    expect((await call("probe/export", tokens.staff)).status).toBe(403);
  });

  it("applies controller-level policies and lets a handler override them", async () => {
    expect((await call("probe-owner", tokens.owner)).status).toBe(200);
    expect((await call("probe-owner", tokens.staff)).status).toBe(403);
  });

  it("serves a public route without a caller, even with a stale cookie, and strips policy fields", async () => {
    for (const token of [undefined, "A".repeat(43), "garbage"]) {
      const response = await call("probe-owner/open", token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: "c1",
        phone: "+971500000000",
        orders: [{ id: "o1", totalFils: 25_000 }],
      });
    }
  });

  it("rejects a revoked session on a permission route", async () => {
    const token = await signIn("owner@iqoshaven.test");
    expect((await call("probe/customer", token)).status).toBe(200);
    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: `__Host-ih_admin=${token}` },
    });
    expect(logout.status).toBe(204);
    expect((await call("probe/customer", token)).status).toBe(401);
    tokens.owner = await signIn("owner@iqoshaven.test");
  });

  it("never accepts an admin session on an internal route", async () => {
    const response = await call("probe/internal", tokens.owner);
    expect(response.status).toBe(401);
  });

  it("drops whatever a no-body route returns", async () => {
    expect((await call("probe/ping", undefined, {})).status).toBe(401);
    const response = await call("probe/ping", tokens.staff, {});
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("never sends a response that violates its contract", async () => {
    const response = await call("probe/leak", tokens.owner);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("argon2");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("reads permissions from the database on every request", async () => {
    const [staffRole, permission] = await Promise.all([
      db.role.findUniqueOrThrow({ where: { key: "staff" } }),
      db.permission.findUniqueOrThrow({ where: { key: "customers.read" } }),
    ]);
    const grant = { roleId: staffRole.id, permissionId: permission.id };
    await db.rolePermission.delete({ where: { roleId_permissionId: grant } });
    try {
      expect((await call("probe/customer", tokens.staff)).status).toBe(403);
    } finally {
      await db.rolePermission.create({ data: grant });
    }
    expect((await call("probe/customer", tokens.staff)).status).toBe(200);
  });

  it("denies a deactivated user on the next request", async () => {
    await db.staffUser.update({
      where: { email: "staff@iqoshaven.test" },
      data: { active: false },
    });
    try {
      expect((await call("probe/customer", tokens.staff)).status).toBe(401);
    } finally {
      await db.staffUser.update({
        where: { email: "staff@iqoshaven.test" },
        data: { active: true },
      });
    }
  });

  it("keeps /me signed-in only and contract-shaped", async () => {
    expect((await call("auth/me")).status).toBe(401);
    const response = await call("auth/me", tokens.staff);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: Record<string, unknown> };
    expect(Object.keys(body.user).sort()).toEqual(["email", "id", "name", "role"]);
  });
});
