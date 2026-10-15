import { describe, expect, it } from "vitest";
import {
  CONTENT_SECTION_KEYS,
  contentReferences,
  contentSchema,
  ContentSchemaError,
  CURRENT_CONTENT_SCHEMA,
} from "./content";

const A = "0199e0a0-0000-7000-8000-000000000001";
const B = "0199e0a0-0000-7000-8000-000000000002";
const C = "0199e0a0-0000-7000-8000-000000000003";
const D = "0199e0a0-0000-7000-8000-000000000004";
const parse = (key: (typeof CONTENT_SECTION_KEYS)[number], value: unknown) =>
  contentSchema(key, 1).safeParse(value);

describe("content section schemas (step 96)", () => {
  it("has a current schema for each of the seven sections", () => {
    expect(CONTENT_SECTION_KEYS).toEqual([
      "ticker",
      "hero",
      "featured",
      "best_sellers",
      "brands",
      "campaign_banner",
      "offers",
    ]);
    for (const key of CONTENT_SECTION_KEYS)
      expect(() => contentSchema(key, CURRENT_CONTENT_SCHEMA[key])).not.toThrow();
    expect(() => contentSchema("hero", 2)).toThrow(ContentSchemaError);
  });

  it("keeps text plain: trimmed, one line, no markup or hidden characters", () => {
    const ok = parse("ticker", { enabled: true, messages: ["  Cash on   delivery ", "UAE-wide"] });
    expect(ok.success && ok.data).toEqual({
      enabled: true,
      messages: ["Cash on delivery", "UAE-wide"],
    });
    for (const message of [
      "<b>10% off</b>",
      "Bell\u0007",
      "Right\u202eleft",
      "Soft\u00adhyphen",
      "Tag\u{E0041}",
      "x".repeat(91),
      " ",
    ])
      expect(parse("ticker", { enabled: true, messages: [message, "Two"] }).success, message).toBe(
        false,
      );
    expect(parse("ticker", { enabled: true, messages: ["Only one"] }).success).toBe(false);
    expect(parse("ticker", { enabled: true, messages: Array(7).fill("Seven") }).success).toBe(
      false,
    );
  });

  it("links inside the store by ID only, and images need alt text", () => {
    const hero = {
      eyebrow: "",
      title: "Every brand, one place",
      subtitle: null,
      cta: { label: "Shop now", link: { kind: "brand", brandId: A } },
      image: { assetId: B, alt: "Three devices on a table" },
    };
    const ok = parse("hero", hero);
    expect(ok.success && ok.data).toMatchObject({ eyebrow: null, subtitle: null });
    for (const link of [
      { kind: "url", href: "https://evil.example" },
      { kind: "brand", brandId: "vektor" },
      { kind: "shop", href: "/shop" },
    ])
      expect(parse("hero", { ...hero, cta: { label: "Go", link } }).success).toBe(false);
    expect(parse("hero", { ...hero, image: { assetId: B, alt: "" } }).success).toBe(false);
    expect(
      parse("hero", { ...hero, image: { url: "data:image/png;base64,AAA", alt: "x" } }).success,
    ).toBe(false);
    expect(parse("hero", { ...hero, title: "" }).success).toBe(false);
    expect(parse("hero", { ...hero, html: "<p>x</p>" }).success).toBe(false);
  });

  it("bounds lists, refuses repeats, and keeps automatic best sellers listless", () => {
    expect(parse("featured", { productIds: [A, B] }).success).toBe(true);
    expect(parse("featured", { productIds: [A, A] }).success).toBe(false);
    expect(
      parse("featured", {
        productIds: Array.from({ length: 9 }, (_, n) => `0199e0a0-0000-7000-8000-00000000001${n}`),
      }).success,
    ).toBe(false);
    expect(parse("best_sellers", { mode: "auto", productIds: [] }).success).toBe(true);
    expect(parse("best_sellers", { mode: "auto", productIds: [A] }).success).toBe(false);
    expect(parse("best_sellers", { mode: "manual", productIds: [A] }).success).toBe(true);
    expect(parse("campaign_banner", { banners: [] }).success).toBe(true);
    const banner = { enabled: true, title: "Pod kits", subtitle: null, cta: null, image: null };
    expect(parse("campaign_banner", { banners: [banner, banner, banner] }).success).toBe(false);
    // No coupon codes are stored in offers (BI-13).
    expect(
      parse("offers", { enabled: true, title: "Offers", productIds: [A], coupons: ["HAVEN10"] })
        .success,
    ).toBe(false);
  });

  it("finds every reference once", () => {
    const hero = contentSchema("hero", 1).parse({
      eyebrow: null,
      title: "Hi",
      subtitle: null,
      cta: { label: "Go", link: { kind: "category", categoryId: C } },
      image: { assetId: D, alt: "A" },
    });
    expect(contentReferences(hero)).toEqual({
      productIds: [],
      brandIds: [],
      categoryIds: [C],
      assetIds: [D],
    });
    const banners = contentSchema("campaign_banner", 1).parse({
      banners: [
        {
          enabled: true,
          title: "One",
          subtitle: null,
          cta: { label: "Go", link: { kind: "product", productId: A } },
          image: null,
        },
        {
          enabled: false,
          title: "Two",
          subtitle: null,
          cta: { label: "Go", link: { kind: "product", productId: A } },
          image: { assetId: B, alt: "B" },
        },
      ],
    });
    expect(contentReferences(banners)).toEqual({
      productIds: [A],
      brandIds: [],
      categoryIds: [],
      assetIds: [B],
    });
    expect(
      contentReferences(contentSchema("brands", 1).parse({ brandIds: [A, B] })).brandIds,
    ).toEqual([A, B]);
  });
});
