import { describe, expect, it } from "vitest";
import { AgeRequiredError, StoreApiError, createStoreApi } from "./api";
import {
  cardBadges,
  cardMeta,
  discountPercent,
  displayAed,
  listingHref,
  parseListing,
} from "./listing";
import { activeFilterCount, parseSearch, searchApiParams, searchHref } from "./search";

describe("listing controls from the address bar", () => {
  it("keeps only known, well-formed values", () => {
    expect(
      parseListing({ brand: "orbe", type: "kit", sort: "price_desc", cursor: "abc_DEF-123" }),
    ).toEqual({ brand: "orbe", type: "kit", sort: "price_desc", cursor: "abc_DEF-123" });
  });

  it("drops tracking parameters, unknown, malformed and repeated values", () => {
    expect(
      parseListing({
        utm_source: "newsletter",
        fbclid: "x",
        brand: "Not A Slug",
        type: "pods",
        sort: "price; DROP TABLE",
        cursor: "has spaces",
        limit: "5000",
        category: "anything",
      }),
    ).toEqual({ sort: "newest" });
    expect(parseListing({ brand: ["a", "b"], sort: ["name", "newest"] })).toEqual({
      sort: "newest",
    });
    expect(parseListing({ brand: "a".repeat(151), cursor: "A".repeat(401) })).toEqual({
      sort: "newest",
    });
  });

  it("builds links without default values", () => {
    expect(listingHref("/shop", { sort: "newest" })).toBe("/shop");
    expect(listingHref("/shop", { type: "kit", brand: "orbe", sort: "name", cursor: "c1" })).toBe(
      "/shop?type=kit&brand=orbe&sort=name&cursor=c1",
    );
    expect(listingHref("/brands/orbe", { sort: "price_asc", cursor: undefined })).toBe(
      "/brands/orbe?sort=price_asc",
    );
  });
});

describe("price and card text", () => {
  it("formats integer fils without floating point", () => {
    expect(displayAed(4900)).toBe("AED 49");
    expect(displayAed(4950)).toBe("AED 49.50");
    expect(displayAed(5)).toBe("AED 0.05");
    expect(displayAed(0)).toBe("AED 0");
    expect(displayAed(123_456_700)).toBe("AED 1,234,567");
    expect(displayAed(1_000_000_000)).toBe("AED 10,000,000");
    for (const bad of [-150, 49.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => displayAed(bad)).toThrow(RangeError);
  });

  it("shows a whole-percent saving only for a real reduction", () => {
    expect(discountPercent(4500, 5900)).toBe(24);
    expect(discountPercent(4900, null)).toBeNull();
    expect(discountPercent(4900, 4900)).toBeNull();
    expect(discountPercent(4900, 4000)).toBeNull();
    expect(discountPercent(9999, 10000)).toBeNull();
  });

  it("describes disposables by puffs and every product by its options", () => {
    expect(cardMeta({ type: "disposable", puffCount: 7000, variantCount: 6 })).toBe(
      "7K puffs · 6 options",
    );
    expect(cardMeta({ type: "disposable", puffCount: 800, variantCount: 1 })).toBe(
      "800 puffs · 1 option",
    );
    expect(cardMeta({ type: "kit", puffCount: null, variantCount: 3 })).toBe("3 options");
  });

  it("lets Sold out replace the other badges; sale and New can sit together", () => {
    const card = { soldOut: false, isNew: true, priceFromFils: 4500, compareAtPriceFils: 5900 };
    expect(cardBadges(card)).toEqual([
      { kind: "sale", label: "−24%" },
      { kind: "new", label: "New" },
    ]);
    expect(cardBadges({ ...card, soldOut: true })).toEqual([
      { kind: "soldOut", label: "Sold out" },
    ]);
    expect(cardBadges({ ...card, isNew: false, compareAtPriceFils: null })).toEqual([]);
  });
});

describe("search page state", () => {
  it("keeps known filters, converts dirhams to fils and drops everything else", () => {
    const state = parseSearch({
      q: "  halo 7k  ",
      type: "disposable",
      brand: ["orbe", "kairo", "orbe", "Not A Slug"],
      minPrice: "30",
      maxPrice: "60",
      minPuffs: "5000",
      nicotine: ["20 mg", " 50 mg ", ""],
      inStock: "true",
      onSale: "yes",
      sort: "price_asc",
      cursor: "abc-123",
      utm_source: "mail",
      limit: "9999",
    });
    expect(state).toEqual({
      q: "halo 7k",
      type: "disposable",
      brands: ["orbe", "kairo"],
      minPrice: 30,
      maxPrice: 60,
      minPuffs: 5000,
      nicotine: ["20 mg", "50 mg"],
      inStock: true,
      onSale: false,
      sort: "price_asc",
      cursor: "abc-123",
    });
    expect(searchApiParams(state)).toEqual([
      ["q", "halo 7k"],
      ["type", "disposable"],
      ["brand", "orbe"],
      ["brand", "kairo"],
      ["minPriceFils", "3000"],
      ["maxPriceFils", "6000"],
      ["minPuffs", "5000"],
      ["nicotine", "20 mg"],
      ["nicotine", "50 mg"],
      ["inStock", "true"],
      ["sort", "price_asc"],
      ["cursor", "abc-123"],
    ]);
    expect(activeFilterCount(state)).toBe(8);
  });

  it("ignores malformed numbers, reversed ranges and oversized lists", () => {
    const state = parseSearch({
      minPrice: "12.5",
      maxPrice: "-3",
      minPuffs: "1e9",
      brand: Array.from({ length: 30 }, (_, index) => "b" + index),
      nicotine: Array.from({ length: 30 }, (_, index) => "n" + index),
      q: "x".repeat(500),
      sort: "rank",
    });
    expect(state).toMatchObject({ inStock: false, onSale: false });
    expect(state.minPrice ?? state.maxPrice ?? state.minPuffs ?? state.sort).toBeUndefined();
    expect(state.brands).toHaveLength(10);
    expect(state.nicotine).toHaveLength(6);
    expect(state.q).toHaveLength(200);
    expect(parseSearch({ minPrice: "500", maxPrice: "100" })).toMatchObject({ brands: [] });
    expect(parseSearch({ minPrice: "500", maxPrice: "100" }).minPrice).toBeUndefined();
    expect(parseSearch({}).q).toBe("");
    expect(searchApiParams(parseSearch({}))).toEqual([]);
  });

  it("builds page links with page-level names and no empty values", () => {
    expect(searchHref({})).toBe("/search");
    expect(
      searchHref({
        q: "halo 7k",
        brands: ["orbe", "kairo"],
        minPrice: 30,
        inStock: true,
        cursor: "c",
      }),
    ).toBe("/search?q=halo+7k&brand=orbe&brand=kairo&minPrice=30&inStock=true&cursor=c");
  });
});

describe("catalogue client", () => {
  const TICKET = "v1.k1.payload.signature";
  const shopper = {
    cookieHeader: `session=secret; ih_age=${TICKET}; cart=abc`,
    clientIp: "203.0.113.7",
  };
  const brands = {
    items: [{ name: "Orbe", slug: "orbe", description: "", productCount: 2, formerSlugs: [] }],
  };
  function api(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = createStoreApi({
      baseUrl: "http://api.internal:4000",
      fetch: (async (input: URL, init: RequestInit) => {
        calls.push({ url: input, init });
        return respond(input, init);
      }) as unknown as typeof fetch,
    });
    return { client, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("forwards only the age ticket and the client address, never caching", async () => {
    const { client, calls } = api(() => json(brands));
    expect(await client.brands(shopper)).toEqual(brands);
    const { url, init } = calls[0]!;
    expect(url.href).toBe("http://api.internal:4000/v1/store/brands");
    expect(init.headers).toEqual({
      accept: "application/json",
      cookie: `ih_age=${TICKET}`,
      "x-ih-client-ip": "203.0.113.7",
    });
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  });

  it("sends only contract parameters, in a fixed order", async () => {
    const { client, calls } = api(() => json({ items: [], nextCursor: null }));
    await client.products(shopper, { sort: "name", brand: "orbe", cursor: "c1", type: "kit" });
    expect(calls[0]!.url.search).toBe("?brand=orbe&type=kit&sort=name&cursor=c1");
    await client.products(shopper, {});
    expect(calls[1]!.url.search).toBe("");
  });

  it("does not call the API at all without a ticket", async () => {
    const { client, calls } = api(() => json(brands));
    for (const cookieHeader of [null, "session=secret", "ih_age=one; ih_age=two"])
      await expect(client.brands({ cookieHeader, clientIp: null })).rejects.toBeInstanceOf(
        AgeRequiredError,
      );
    expect(calls).toHaveLength(0);
  });

  it("maps a refused ticket, a missing product and failures distinctly", async () => {
    const refused = api(() => json({ error: { code: "AGE_VERIFICATION_REQUIRED" } }, 403));
    await expect(refused.client.brands(shopper)).rejects.toBeInstanceOf(AgeRequiredError);
    const missing = api(() => json({ error: { code: "NOT_FOUND" } }, 404));
    expect(await missing.client.product(shopper, "gone")).toBeNull();
    expect(missing.calls[0]!.url.pathname).toBe("/v1/store/products/gone");
    for (const status of [403, 429, 500, 503]) {
      const failing = api(() => json({ error: { code: "X" } }, status));
      await expect(failing.client.brands(shopper)).rejects.toMatchObject({ status });
    }
    const down = api(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(down.client.brands(shopper)).rejects.toBeInstanceOf(StoreApiError);
  });

  it("never renders a body that does not match the contract", async () => {
    for (const body of [{ items: [{ name: "Orbe", costFils: 1 }] }, "<html>", null]) {
      const { client } = api(() => json(body));
      await expect(client.brands(shopper)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("encodes the slug into one path segment", async () => {
    const { client, calls } = api(() => json({ error: {} }, 404));
    await client.product(shopper, "../../admin/products");
    expect(calls[0]!.url.pathname).toBe("/v1/store/products/..%2F..%2Fadmin%2Fproducts");
  });
});
