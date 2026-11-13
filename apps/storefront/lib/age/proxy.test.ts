import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageTicketKeyRing,
  ageTicketPublicKey,
  ageTicketSigner,
  readAgeCookie,
  signAgeTicket,
  verifyAgeTicket,
} from "@ih/platform/age-ticket";

const seed = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .subarray(-32)
  .toString("base64url");
const signer = ageTicketSigner("test", seed);
const keys = ageTicketKeyRing([{ kid: "test", publicKey: ageTicketPublicKey(signer) }]);
const runtime = {
  keys,
  signer: signer as typeof signer | undefined,
  policyVersion: "v1",
  origins: ["https://shop.test"],
};
let indexing: "closed" | "public_pages" | "catalogue" = "closed";
const isVerifiedCrawler = vi.fn<(agent: string | null, ip: string | null) => Promise<boolean>>();

vi.mock("@/lib/age/runtime", () => ({ ageGate: () => ({ runtime }) }));
vi.mock("@/lib/age/crawler", () => ({ isVerifiedCrawler }));
vi.mock("@/lib/seo-policy", async (original) => ({
  ...(await original<typeof import("@/lib/seo-policy")>()),
  readSeoPolicy: () => Promise.resolve({ indexing }),
}));
const { proxy } = await import("@/proxy");

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new NextRequest(`https://shop.test${path}`, { headers, method });
const crawler = { "user-agent": GOOGLEBOT, "x-ih-client-ip": "66.249.66.1" };
/** The cookie the page (and through it the API) will see, as Next forwards it. */
const forwardedTicket = (response: Response) =>
  readAgeCookie(response.headers.get("x-middleware-request-cookie") ?? undefined);
const gated = (response: Response) =>
  response.status === 307 && (response.headers.get("location") ?? "").includes("/age-check");

describe("routing gate: search crawlers and indexing (ADR 0114)", () => {
  beforeEach(() => {
    indexing = "catalogue";
    runtime.signer = signer;
    isVerifiedCrawler.mockReset().mockResolvedValue(true);
  });

  it("lets a verified crawler read a catalogue page with a short-lived ticket", async () => {
    const response = await proxy(request("/p/terea-amber", crawler));
    expect(response.status).toBe(200);
    expect(isVerifiedCrawler).toHaveBeenCalledWith(GOOGLEBOT, "66.249.66.1");
    const ticket = verifyAgeTicket(forwardedTicket(response), {
      keys,
      audience: "api",
      policyVersion: "v1",
    });
    expect(ticket.ok).toBe(true);
    if (ticket.ok) {
      expect(ticket.claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
      // The signed mark the API uses for the crawler read budget and statistics (ADR 0115).
      expect(ticket.claims.via).toBe("crawler");
    }
    expect(response.headers.get("set-cookie")).toMatch(/^ih_age=.+Max-Age=600; .*HttpOnly/);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-middleware-request-x-ih-indexable")).toBe("1");
  });

  it("gates a crawler name whose address is not confirmed", async () => {
    isVerifiedCrawler.mockResolvedValue(false);
    const response = await proxy(request("/p/terea-amber", crawler));
    expect(gated(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("gives no pass outside catalogue pages, for writes, or under another policy", async () => {
    for (const path of ["/cart", "/checkout", "/search?q=terea", "/track", "/_next/image?url=x"])
      expect(gated(await proxy(request(path, crawler)))).toBe(true);
    expect((await proxy(request("/p/terea-amber", crawler, "POST"))).status).toBe(303);
    for (const policy of ["closed", "public_pages"] as const) {
      indexing = policy;
      expect(gated(await proxy(request("/p/terea-amber", crawler)))).toBe(true);
    }
    expect(isVerifiedCrawler).not.toHaveBeenCalled();
  });

  it("gives no pass when no signing key is configured", async () => {
    runtime.signer = undefined;
    expect(gated(await proxy(request("/p/terea-amber", crawler)))).toBe(true);
  });

  it("keeps a shopper's own ticket and never asks DNS for it", async () => {
    const { ticket } = signAgeTicket(signer, { policyVersion: "v1", ttlSeconds: 600 });
    const response = await proxy(
      request("/p/terea-amber", { cookie: `ih_age=${ticket}`, "x-ih-indexable": "0" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(isVerifiedCrawler).not.toHaveBeenCalled();
  });

  it("marks pages noindex unless the policy offers that exact page", async () => {
    const { ticket } = signAgeTicket(signer, { policyVersion: "v1", ttlSeconds: 600 });
    const visit = async (path: string) => {
      const response = await proxy(
        // A client-supplied hint is always replaced by the gate's own decision.
        request(path, { cookie: `ih_age=${ticket}`, "x-ih-indexable": "1" }),
      );
      return {
        noindex: response.headers.get("x-robots-tag") === "noindex, nofollow",
        hint: response.headers.get("x-middleware-request-x-ih-indexable"),
      };
    };
    expect(await visit("/p/terea-amber")).toEqual({ noindex: false, hint: "1" });
    expect(await visit("/terms")).toEqual({ noindex: false, hint: "1" });
    expect(await visit("/cart")).toEqual({ noindex: true, hint: null });
    expect(await visit("/P/terea-amber")).toEqual({ noindex: true, hint: null });
    indexing = "public_pages";
    expect(await visit("/p/terea-amber")).toEqual({ noindex: true, hint: null });
    expect(await visit("/terms")).toEqual({ noindex: false, hint: "1" });
    indexing = "closed";
    expect(await visit("/")).toEqual({ noindex: true, hint: null });
    expect(await visit("/terms")).toEqual({ noindex: true, hint: null });
  });
});
