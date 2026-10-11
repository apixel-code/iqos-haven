import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  AGE_COOKIE,
  ageTicketKeyRing,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
  verifyAgeTicket,
  type AgeTicketResult,
} from "@ih/platform/age-ticket";
import { EndpointLimiter, LocalRateLimiter } from "@ih/platform/rate-limit";
import { describe, expect, it } from "vitest";
import { createAgeHandlers, verifyRequestTicket, type AgeRuntime } from "./handlers";
import {
  AGE_CHECK_PATH,
  RESTRICTED_COOKIE,
  RESTRICTED_PATH,
  gateAction,
  hasRestrictedCookie,
  isPublicPath,
  isSameOriginPost,
  safeReturnPath,
} from "./policy";

const ORIGIN = "https://shop.example";
const POLICY = "p1";
function newSigner(kid: string) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    kid,
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
}
const signer = newSigner("k1");
function runtime(overrides: Partial<AgeRuntime> = {}): AgeRuntime {
  const local = new LocalRateLimiter({ maxKeys: 1000 });
  return {
    keys: ageTicketKeyRing([{ kid: signer.kid, publicKey: ageTicketPublicKey(signer) }]),
    signer,
    policyVersion: POLICY,
    ticketTtlSeconds: 30 * 86_400,
    restrictedSeconds: 900,
    origins: [ORIGIN],
    limiter: new EndpointLimiter({ primary: local, local, keySecret: randomBytes(32) }),
    ...overrides,
  };
}
const post = (
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) =>
  new Request(ORIGIN + path, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      "x-ih-client-ip": "203.0.113.7",
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
const cookies = (response: Response) => response.headers.getSetCookie();
const valid: AgeTicketResult = {
  ok: true,
  kid: "k1",
  claims: {
    iss: "ih-storefront",
    aud: ["storefront", "api"],
    iat: 0,
    exp: 1,
    pol: POLICY,
    dec: "accepted",
  },
};
const none: AgeTicketResult = { ok: false, reason: "MISSING" };

describe("safe return URL", () => {
  it.each([
    ["/shop", "/shop"],
    ["/products/halo?variant=mint&q=a%20b", "/products/halo?variant=mint&q=a%20b"],
    ["/", "/"],
  ])("keeps the local path %s", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it.each([
    "https://evil.example/",
    "//evil.example/path",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F%2Fevil.example/../..//evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/shop\r\nSet-Cookie: x=1",
    "/shop\u0000",
    "/a/../..//evil.example",
    "/api/age/accept",
    "/api/v1/store/products",
    "/_next/image?url=%2Fx.png&w=64&q=75",
    AGE_CHECK_PATH,
    RESTRICTED_PATH,
    "/" + "a".repeat(600),
    "",
  ])("falls back to / for %j", (input) => {
    const result = safeReturnPath(input);
    expect(result === "/" || (result.startsWith("/") && !result.startsWith("//"))).toBe(true);
    // Whatever is returned resolves on our own origin.
    expect(new URL(result, ORIGIN).origin).toBe(ORIGIN);
    if (/evil|javascript|Set-Cookie|\/api\/|age-check|restricted/.test(input))
      expect(result).not.toMatch(/evil\.example$|^\/api\/|age-check|restricted|Set-Cookie/);
  });

  it("returns exactly / for null, absolute and scheme-relative input", () => {
    for (const input of [
      null,
      undefined,
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
    ])
      expect(safeReturnPath(input)).toBe("/");
  });
});

describe("routing gate", () => {
  const act = (pathname: string, ticket: AgeTicketResult, restricted = false, search = "") =>
    gateAction({ pathname, search, ticket, restricted });

  it("restricts every path by default and lists the public ones explicitly", () => {
    for (const path of [
      "/",
      "/shop",
      "/products/halo",
      "/cart",
      "/checkout",
      "/api/anything",
      "/health/x",
      "/age-checks",
      "/api/age/",
      "/api/age/status",
      "/api/age/accept/extra",
      "/_next/image",
    ])
      expect(isPublicPath(path), path).toBe(false);
    for (const path of [
      AGE_CHECK_PATH,
      RESTRICTED_PATH,
      "/health",
      "/api/age/accept",
      "/api/age/reject",
    ])
      expect(isPublicPath(path), path).toBe(true);
  });

  it("sends an unverified visitor to the age check, remembering a safe target", () => {
    expect(act("/", none)).toEqual({ kind: "redirect", location: AGE_CHECK_PATH });
    expect(act("/products/halo", none, false, "?variant=mint")).toEqual({
      kind: "redirect",
      location: `${AGE_CHECK_PATH}?return=${encodeURIComponent("/products/halo?variant=mint")}`,
    });
    expect(act(AGE_CHECK_PATH, none)).toEqual({ kind: "allow" });
    expect(act("/api/age/accept", none)).toEqual({ kind: "allow" });
  });

  it("treats every ticket failure the same as no ticket", () => {
    for (const reason of [
      "EXPIRED",
      "BAD_SIGNATURE",
      "UNKNOWN_KEY",
      "POLICY_CHANGED",
      "MALFORMED",
    ] as const)
      expect(act("/shop", { ok: false, reason }).kind).toBe("redirect");
  });

  it("lets a verified shopper through and away from the gate pages", () => {
    expect(act("/products/halo", valid)).toEqual({ kind: "allow" });
    expect(act(AGE_CHECK_PATH, valid, false, "?return=%2Fcart")).toEqual({
      kind: "redirect",
      location: "/cart",
    });
    expect(act(AGE_CHECK_PATH, valid, false, "?return=https%3A%2F%2Fevil.example")).toEqual({
      kind: "redirect",
      location: "/",
    });
    expect(act(RESTRICTED_PATH, valid)).toEqual({ kind: "redirect", location: "/" });
  });

  it("keeps a recently rejected device on the restricted page, including the gate itself", () => {
    for (const path of ["/", "/shop", AGE_CHECK_PATH])
      expect(act(path, none, true)).toEqual({ kind: "redirect", location: RESTRICTED_PATH });
    expect(act(RESTRICTED_PATH, none, true)).toEqual({ kind: "allow" });
    // A valid ticket (accepted afterwards) outranks the restricted marker.
    expect(act("/shop", valid, true)).toEqual({ kind: "allow" });
  });

  it("reads only an exact restricted marker", () => {
    expect(hasRestrictedCookie(`a=1; ${RESTRICTED_COOKIE}=1`)).toBe(true);
    expect(hasRestrictedCookie(`${RESTRICTED_COOKIE}=0`)).toBe(false);
    expect(hasRestrictedCookie(`x${RESTRICTED_COOKIE}=1`)).toBe(false);
    expect(hasRestrictedCookie(null)).toBe(false);
  });
});

describe("origin validation", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  it("requires our own Origin and refuses cross-site requests", () => {
    expect(isSameOriginPost(headers({ origin: ORIGIN }), [ORIGIN])).toBe(true);
    expect(
      isSameOriginPost(headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" }), [ORIGIN]),
    ).toBe(true);
    expect(isSameOriginPost(headers({}), [ORIGIN])).toBe(false);
    expect(isSameOriginPost(headers({ origin: "null" }), [ORIGIN])).toBe(false);
    expect(isSameOriginPost(headers({ origin: "https://evil.example" }), [ORIGIN])).toBe(false);
    expect(isSameOriginPost(headers({ origin: ORIGIN + ".evil.example" }), [ORIGIN])).toBe(false);
    for (const site of ["cross-site", "same-site"])
      expect(isSameOriginPost(headers({ origin: ORIGIN, "sec-fetch-site": site }), [ORIGIN])).toBe(
        false,
      );
  });
});

describe("accept and reject handlers", () => {
  it("accept sets an HttpOnly signed ticket that verifies, and returns to a safe local path", async () => {
    const rt = runtime();
    const response = await createAgeHandlers(rt).accept(
      post("/api/age/accept", { return: "/products/halo?variant=mint" }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/products/halo?variant=mint");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [age, restricted] = cookies(response);
    expect(age).toMatch(
      new RegExp(
        `^${AGE_COOKIE}=v1\\.k1\\.[\\w-]+\\.[\\w-]+; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    expect(restricted).toBe(
      `${RESTRICTED_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    const ticket = age!.split(";")[0]!.slice(AGE_COOKIE.length + 1);
    expect(verifyRequestTicket(rt, `${AGE_COOKIE}=${ticket}`).ok).toBe(true);
    // The same ticket is what the API verifies.
    expect(
      verifyAgeTicket(ticket, { keys: rt.keys, audience: "api", policyVersion: POLICY }).ok,
    ).toBe(true);
    expect(await response.text()).toBe("");
  });

  it("never redirects off-site after accepting", async () => {
    const handlers = createAgeHandlers(runtime());
    for (const target of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/api/age/reject",
      "",
    ]) {
      const response = await handlers.accept(post("/api/age/accept", { return: target }));
      expect(response.headers.get("location"), target).toBe("/");
    }
    const noBody = new Request(ORIGIN + "/api/age/accept", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect((await handlers.accept(noBody)).headers.get("location")).toBe("/");
  });

  it("reject clears the acceptance and sets the short-lived restricted marker", async () => {
    const response = await createAgeHandlers(runtime()).reject(post("/api/age/reject"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(RESTRICTED_PATH);
    expect(cookies(response)).toEqual([
      `${AGE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
      `${RESTRICTED_COOKIE}=1; Max-Age=900; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ]);
  });

  it("refuses foreign, missing and cross-site origins without setting any cookie", async () => {
    const handlers = createAgeHandlers(runtime());
    const foreign: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of foreign)
      for (const call of [handlers.accept, handlers.reject]) {
        const response = await call(post("/api/age/accept", {}, headers));
        expect(response.status).toBe(403);
        expect(cookies(response)).toEqual([]);
      }
    const bare = new Request(ORIGIN + "/api/age/accept", { method: "POST" });
    expect((await handlers.accept(bare)).status).toBe(403);
  });

  it("rate limits decisions per client address and ignores a malformed address header", async () => {
    const handlers = createAgeHandlers(runtime());
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 22; attempt++)
      statuses.push((await handlers.accept(post("/api/age/accept"))).status);
    expect(statuses.filter((status) => status === 303)).toHaveLength(20);
    const limited = await handlers.reject(post("/api/age/reject"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(cookies(limited)).toEqual([]);
    // Another address is unaffected; junk addresses share one bucket instead of bypassing.
    expect(
      (await handlers.accept(post("/api/age/accept", {}, { "x-ih-client-ip": "198.51.100.9" })))
        .status,
    ).toBe(303);
    const junk = [];
    for (let attempt = 0; attempt < 21; attempt++)
      junk.push(
        (
          await handlers.accept(
            post("/api/age/accept", {}, { "x-ih-client-ip": "not-an-ip-" + attempt }),
          )
        ).status,
      );
    expect(junk.at(-1)).toBe(429);
  });

  it("is unavailable, not open, when no signing key is configured", async () => {
    const response = await createAgeHandlers(runtime({ signer: undefined })).accept(
      post("/api/age/accept"),
    );
    expect(response.status).toBe(503);
    expect(cookies(response)).toEqual([]);
  });

  it("a ticket from another key or policy does not pass the routing gate", () => {
    const rt = runtime();
    const foreign = signAgeTicket(newSigner("k1"), {
      policyVersion: POLICY,
      ttlSeconds: 60,
    }).ticket;
    const oldPolicy = signAgeTicket(signer, { policyVersion: "p0", ttlSeconds: 60 }).ticket;
    for (const ticket of [foreign, oldPolicy, "true", ""])
      expect(verifyRequestTicket(rt, `${AGE_COOKIE}=${ticket}`).ok).toBe(false);
    expect(verifyRequestTicket(rt, null).ok).toBe(false);
  });
});
