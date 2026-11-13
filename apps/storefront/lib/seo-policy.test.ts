import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  storefrontEnv: () => ({ API_INTERNAL_URL: "http://api.test", SEO_POLICY_CACHE_SECONDS: 60 }),
}));
const { crawlerMayRead, forgetSeoPolicy, INDEXABLE_PATHS, pageIsIndexable, readSeoPolicy } =
  await import("./seo-policy");

describe("indexing policy on the storefront (step 113)", () => {
  afterEach(() => {
    forgetSeoPolicy();
    vi.unstubAllGlobals();
  });

  it("stays closed on any failure or unexpected answer", async () => {
    for (const answer of [
      () => Promise.reject(new Error("down")),
      () => Promise.resolve(new Response("{}", { status: 500 })),
      () => Promise.resolve(Response.json({ indexing: "products" })),
      () => Promise.resolve(Response.json({ indexing: "public_pages", extra: 1 })),
    ]) {
      forgetSeoPolicy();
      vi.stubGlobal("fetch", vi.fn(answer));
      expect(await readSeoPolicy()).toEqual({ indexing: "closed" });
    }
  });

  it("follows the Owner's choice, held for a minute", async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json({ indexing: "public_pages" })));
    vi.stubGlobal("fetch", fetch);
    expect(await readSeoPolicy(0)).toEqual({ indexing: "public_pages" });
    await readSeoPolicy(59_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await readSeoPolicy(61_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("offers only the policy pages under public pages, never a catalogue page", () => {
    expect(INDEXABLE_PATHS).toEqual(["/responsible-use", "/terms", "/privacy"]);
    const open = { indexing: "public_pages" } as const;
    expect(pageIsIndexable(open, "/terms")).toBe(true);
    for (const path of ["/", "/shop", "/p/anything", "/brands/x", "/age-check"])
      expect(pageIsIndexable(open, path)).toBe(false);
    expect(pageIsIndexable({ indexing: "closed" }, "/terms")).toBe(false);
  });

  it("offers catalogue pages only under the catalogue policy (ADR 0114)", () => {
    const catalogue = { indexing: "catalogue" } as const;
    for (const path of [
      "/",
      "/shop",
      "/devices",
      "/sticks",
      "/brands",
      "/offers",
      "/help",
      "/p/terea-amber",
      "/p/terea-amber/image",
      "/brands/iqos",
      "/categories/terea-japan",
      "/terms",
    ])
      expect(pageIsIndexable(catalogue, path)).toBe(true);
    // A shopper's own pages, the gate, API routes and other spellings are never offered.
    for (const path of [
      "/cart",
      "/checkout",
      "/search",
      "/wishlist",
      "/compare",
      "/track",
      "/order-confirmation",
      "/review",
      "/age-check",
      "/restricted",
      "/api/age/accept",
      "/_next/image",
      "/P/terea-amber",
      "/Shop",
      "/p/",
      "/p/a/b",
      "/p/terea-amber/image/x",
      "/categories/x/y",
    ])
      expect(pageIsIndexable(catalogue, path)).toBe(false);
  });

  it("lets a verified crawler read catalogue pages only, and only to read", () => {
    const catalogue = { indexing: "catalogue" } as const;
    expect(crawlerMayRead(catalogue, "GET", "/p/terea-amber")).toBe(true);
    expect(crawlerMayRead(catalogue, "HEAD", "/")).toBe(true);
    expect(crawlerMayRead(catalogue, "POST", "/p/terea-amber")).toBe(false);
    expect(crawlerMayRead(catalogue, "GET", "/cart")).toBe(false);
    expect(crawlerMayRead(catalogue, "GET", "/checkout")).toBe(false);
    // The policy pages need no pass, and other policies never give one.
    expect(crawlerMayRead(catalogue, "GET", "/terms")).toBe(false);
    for (const indexing of ["closed", "public_pages"] as const)
      expect(crawlerMayRead({ indexing }, "GET", "/p/terea-amber")).toBe(false);
  });
});
