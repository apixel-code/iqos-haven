import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_MS,
  InMemoryNonceStore,
  SERVICE_AUTH_HEADERS,
  signServiceRequest,
  verifyServiceRequest,
  type ServiceKey,
} from "./service-auth";

const secret = () => randomBytes(32).toString("base64url");
const worker: ServiceKey = { service: "worker", keyId: "k1", secret: secret() };
const workerNext: ServiceKey = { service: "worker", keyId: "k2", secret: secret() };
const storefront: ServiceKey = { service: "storefront", keyId: "k1", secret: secret() };
const request = {
  method: "POST",
  path: "/v1/internal/revalidate?tag=catalog",
  body: '{"tag":"catalog"}',
};
const now = Date.parse("2026-10-09T10:00:00Z");

function verify(
  headers: Record<string, string>,
  overrides: Partial<typeof request> = {},
  options: {
    allowed?: string[];
    nonces?: InMemoryNonceStore;
    at?: number;
    keys?: ServiceKey[];
  } = {},
) {
  return verifyServiceRequest(
    { ...request, ...overrides, headers },
    {
      keys: options.keys ?? [worker, workerNext, storefront],
      allowedServices: options.allowed ?? ["worker"],
      nonces: options.nonces ?? new InMemoryNonceStore(),
      now: options.at ?? now,
    },
  );
}

describe("service auth", () => {
  it("accepts a correctly signed request from an allowed service", async () => {
    expect(await verify(signServiceRequest(worker, request, now))).toEqual({
      ok: true,
      service: "worker",
      keyId: "k1",
    });
  });

  it("supports key rotation: either active key id verifies", async () => {
    expect(await verify(signServiceRequest(workerNext, request, now))).toMatchObject({
      ok: true,
      keyId: "k2",
    });
  });

  it.each([
    ["method", { method: "GET" }],
    ["path", { path: "/v1/internal/revalidate?tag=all" }],
    ["body", { body: '{"tag":"everything"}' }],
  ])("rejects a tampered %s", async (_name, change) => {
    expect(await verify(signServiceRequest(worker, request, now), change)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("rejects a signature made with another service's key", async () => {
    const forged = {
      ...signServiceRequest(storefront, request, now),
      [SERVICE_AUTH_HEADERS.service]: "worker",
    };
    expect(await verify(forged)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects callers that are not allowed on the route, and unknown keys", async () => {
    expect(await verify(signServiceRequest(storefront, request, now))).toEqual({
      ok: false,
      reason: "SERVICE_NOT_ALLOWED",
    });
    expect(
      await verify(signServiceRequest(worker, request, now), {}, { keys: [storefront] }),
    ).toEqual({
      ok: false,
      reason: "UNKNOWN_KEY",
    });
  });

  it("rejects requests outside the clock window", async () => {
    const headers = signServiceRequest(worker, request, now);
    expect(await verify(headers, {}, { at: now + MAX_CLOCK_SKEW_MS + 1000 })).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
    expect(await verify(headers, {}, { at: now - MAX_CLOCK_SKEW_MS - 1000 })).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
  });

  it("rejects a replayed request but lets a bad signature not burn the nonce", async () => {
    const nonces = new InMemoryNonceStore();
    const headers = signServiceRequest(worker, request, now);
    const forged = await verify(
      { ...headers, [SERVICE_AUTH_HEADERS.signature]: "AAAA" },
      {},
      { nonces },
    );
    expect(forged.ok).toBe(false);
    expect((await verify(headers, {}, { nonces })).ok).toBe(true);
    expect(await verify(headers, {}, { nonces })).toEqual({ ok: false, reason: "REPLAYED_NONCE" });
  });

  it("rejects missing or malformed headers", async () => {
    expect(await verify({})).toEqual({ ok: false, reason: "MISSING_HEADERS" });
    expect(
      await verify({
        ...signServiceRequest(worker, request, now),
        [SERVICE_AUTH_HEADERS.timestamp]: "soon",
      }),
    ).toEqual({
      ok: false,
      reason: "MISSING_HEADERS",
    });
  });

  it("fails closed when the nonce store is full or unavailable", async () => {
    const full = new InMemoryNonceStore(2);
    expect(await full.claim("a", 60)).toBe(true);
    expect(await full.claim("b", 60)).toBe(true);
    expect(await full.claim("c", 60)).toBe(false); // live nonces are never evicted
    expect(await full.claim("a", 60)).toBe(false);
    const broken = { claim: async () => Promise.reject(new Error("redis down")) };
    expect(
      await verify(signServiceRequest(worker, request, now), {}, { nonces: broken as never }),
    ).toEqual({
      ok: false,
      reason: "REPLAYED_NONCE",
    });
  });

  it("expires nonces after the acceptance window", async () => {
    let clock = now;
    const store = new InMemoryNonceStore(10, () => clock);
    expect(await store.claim("n", 61)).toBe(true);
    clock += 62_000;
    expect(await store.claim("n", 61)).toBe(true);
  });
});
