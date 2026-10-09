import "reflect-metadata";
import { randomBytes } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Post,
  Req,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { signServiceRequest, SERVICE_AUTH_HEADERS, type ServiceKey } from "@ih/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorFilter } from "../http/error.filter";
import { API_ENV, QUEUE_REDIS } from "../infra/tokens";
import { InternalModule } from "./internal.module";
import { InternalService, type InternalRequest } from "./service-auth.guard";

const worker: ServiceKey = {
  service: "worker",
  keyId: "k1",
  secret: randomBytes(32).toString("base64url"),
};
const storefront: ServiceKey = {
  service: "storefront",
  keyId: "k1",
  secret: randomBytes(32).toString("base64url"),
};

// Test-only routes: production has no internal controller until a feature needs one.
@Controller("internal-test")
class ProbeController {
  @Get("whoami")
  @InternalService("worker")
  whoami(@Req() request: InternalRequest) {
    return request.serviceIdentity;
  }

  @Post("echo")
  @InternalService("worker", "storefront")
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

const nonceKeys = new Set<string>();
let redisDown = false;
const fakeRedis = {
  status: "ready",
  async set(key: string): Promise<"OK" | null> {
    if (redisDown) throw new Error("redis down");
    if (nonceKeys.has(key)) return null;
    nonceKeys.add(key);
    return "OK";
  },
};

// Mirrors the real app, where the global InfraModule provides API_ENV.
@Global()
@Module({
  providers: [
    {
      provide: API_ENV,
      useValue: { LOG_LEVEL: "silent", INTERNAL_SERVICE_KEYS: [worker, storefront] },
    },
    // Stand-in for the queue Redis used as the shared nonce store (SET NX EX semantics).
    { provide: QUEUE_REDIS, useValue: fakeRedis },
  ],
  exports: [API_ENV, QUEUE_REDIS],
})
class ProbeEnvModule {}

@Module({ imports: [ProbeEnvModule, InternalModule], controllers: [ProbeController] })
class ProbeModule {}

describe("ServiceAuthGuard (Fastify)", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
      rawBody: true,
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  const get = (headers: Record<string, string>, path = "/internal-test/whoami") =>
    fetch(base + path, { headers });

  it("admits a signed request from an allowed service and exposes its identity", async () => {
    const response = await get(
      signServiceRequest(worker, { method: "GET", path: "/internal-test/whoami" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "worker", keyId: "k1" });
  });

  it("returns the standard 401 envelope for unsigned, cookie-only or disallowed callers", async () => {
    for (const headers of [
      {},
      { cookie: "ih_admin_session=whatever" },
      signServiceRequest(storefront, { method: "GET", path: "/internal-test/whoami" }),
    ]) {
      const response = await get(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
  });

  it("binds the signature to the exact path, query and body", async () => {
    const signed = signServiceRequest(worker, { method: "GET", path: "/internal-test/whoami?x=1" });
    expect((await get(signed, "/internal-test/whoami?x=2")).status).toBe(401);
    const body = JSON.stringify({ tag: "catalog" });
    const post = (sentBody: string, headers: Record<string, string>) =>
      fetch(base + "/internal-test/echo", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: sentBody,
      });
    const headers = signServiceRequest(storefront, {
      method: "POST",
      path: "/internal-test/echo",
      body,
    });
    expect((await post(JSON.stringify({ tag: "everything" }), headers)).status).toBe(401);
    const fresh = signServiceRequest(storefront, {
      method: "POST",
      path: "/internal-test/echo",
      body,
    });
    const ok = await post(body, fresh);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ received: { tag: "catalog" } });
  });

  it("denies internal calls while the shared nonce store is unavailable", async () => {
    redisDown = true;
    try {
      const response = await get(
        signServiceRequest(worker, { method: "GET", path: "/internal-test/whoami" }),
      );
      expect(response.status).toBe(401);
    } finally {
      redisDown = false;
    }
  });

  it("rejects a replay of an accepted request", async () => {
    const headers = signServiceRequest(worker, { method: "GET", path: "/internal-test/whoami" });
    expect((await get(headers)).status).toBe(200);
    expect((await get(headers)).status).toBe(401);
    expect(headers[SERVICE_AUTH_HEADERS.nonce]).toBeDefined();
  });
});

describe("ServiceAuthGuard without captured raw body", () => {
  let app: INestApplication;
  let base: string;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  it("refuses a signed request whose body bytes cannot be verified", async () => {
    const body = JSON.stringify({ tag: "catalog" });
    // Signed as if the body were empty: without raw bytes the guard must not accept it.
    const headers = signServiceRequest(storefront, { method: "POST", path: "/internal-test/echo" });
    const response = await fetch(base + "/internal-test/echo", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(response.status).toBe(401);
  });
});
