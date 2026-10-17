import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  storefrontEnv: () => ({ API_INTERNAL_URL: "http://api.test", SEO_POLICY_CACHE_SECONDS: 60 }),
}));
const { forgetSeoPolicy, INDEXABLE_PATHS, pageIsIndexable, readSeoPolicy } =
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

  it("only ever offers the policy pages, never a catalogue page", () => {
    expect(INDEXABLE_PATHS).toEqual(["/responsible-use", "/terms", "/privacy"]);
    const open = { indexing: "public_pages" } as const;
    expect(pageIsIndexable(open, "/terms")).toBe(true);
    for (const path of ["/", "/shop", "/p/anything", "/brands/x", "/age-check"])
      expect(pageIsIndexable(open, path)).toBe(false);
    expect(pageIsIndexable({ indexing: "closed" }, "/terms")).toBe(false);
  });
});
