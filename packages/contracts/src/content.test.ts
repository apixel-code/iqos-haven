import { describe, expect, it } from "vitest";
import {
  CONTENT_SECTION_KEYS,
  contentReferences,
  contentSchema,
  ContentSchemaError,
  CURRENT_CONTENT_SCHEMA,
  upgradeContent,
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
    expect(() => contentSchema("hero", 4)).toThrow(ContentSchemaError);
  });

  it("holds one to three hero slides and reads a v1 hero as one navy slide (ADR 0097)", () => {
    const slide = {
      style: "lilac",
      eyebrow: null,
      title: "New in",
      subtitle: null,
      cta: { label: "Shop", link: { kind: "shop" } },
      secondaryCta: null,
      image: null,
    };
    const v2 = contentSchema("hero", 2);
    expect(v2.safeParse({ slides: [slide] }).success).toBe(true);
    expect(v2.safeParse({ slides: [] }).success).toBe(false);
    expect(v2.safeParse({ slides: [slide, slide, slide, slide] }).success).toBe(false);
    expect(v2.safeParse({ slides: [{ ...slide, style: "dark" }] }).success).toBe(false);
    const v1 = {
      eyebrow: "Old",
      title: "One hero",
      subtitle: null,
      cta: null,
      image: null,
    };
    const v3 = contentSchema("hero", 3);
    expect(upgradeContent("hero", 1, v1)).toEqual({
      slides: [{ style: "navy", ...v1, secondaryCta: null, mobileImage: null }],
    });
    expect(v3.safeParse(upgradeContent("hero", 1, v1)).success).toBe(true);
    // A v2 slide gains an empty phone picture; the current version passes through unchanged.
    expect(upgradeContent("hero", 2, { slides: [slide] })).toEqual({
      slides: [{ ...slide, mobileImage: null }],
    });
    const current = { slides: [{ ...slide, mobileImage: null }] };
    expect(upgradeContent("hero", 3, current)).toEqual(current);
    expect(upgradeContent("brands", 1, { brandIds: [] })).toEqual({ brandIds: [] });
  });

  it("takes a designed banner only with its picture, and a phone picture on any slide (ADR 0105)", () => {
    const v3 = contentSchema("hero", 3);
    const picture = { assetId: "01a1a051-f525-76f9-9f0c-31cd249711c3", alt: "IQOS ILUMA offer" };
    const banner = {
      style: "banner",
      eyebrow: null,
      title: "IQOS ILUMA offer",
      subtitle: null,
      cta: { label: "Shop", link: { kind: "shop" } },
      secondaryCta: null,
      image: picture,
      mobileImage: { ...picture, alt: "IQOS ILUMA offer, phone" },
    };
    expect(v3.safeParse({ slides: [banner] }).success).toBe(true);
    expect(v3.safeParse({ slides: [{ ...banner, mobileImage: null }] }).success).toBe(true);
    expect(v3.safeParse({ slides: [{ ...banner, image: null }] }).success).toBe(false);
    // v2 never knew banners; a v3 slide without the phone field has none.
    expect(contentSchema("hero", 2).safeParse({ slides: [banner] }).success).toBe(false);
    const { mobileImage: _phone, ...withoutPhone } = banner;
    expect(v3.parse({ slides: [withoutPhone] })).toMatchObject({
      slides: [{ mobileImage: null }],
    });
  });

  it("takes a photo slide only with its picture, in either text colour (ADR 0108)", () => {
    const v3 = contentSchema("hero", 3);
    const picture = { assetId: "01a1a051-f525-76f9-9f0c-31cd249711c3", alt: "IQOS ILUMA i range" };
    const photo = {
      style: "photo-light",
      eyebrow: "New",
      title: "IQOS ILUMA i",
      subtitle: "Four colours.",
      cta: { label: "Shop", link: { kind: "shop" } },
      secondaryCta: { label: "TEREA", link: { kind: "shop" } },
      image: picture,
      mobileImage: null,
    };
    expect(v3.safeParse({ slides: [photo, { ...photo, style: "photo-dark" }] }).success).toBe(true);
    expect(v3.safeParse({ slides: [{ ...photo, image: null }] }).success).toBe(false);
    expect(v3.safeParse({ slides: [{ ...photo, style: "photo" }] }).success).toBe(false);
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
