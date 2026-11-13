import type { StoreProductResponse } from "@ih/contracts";
import { describe, expect, it } from "vitest";
import { breadcrumbJsonLd, jsonLdText, metaDescription, productJsonLd } from "./seo-data";

const product = {
  slug: "terea-amber",
  name: "TEREA Amber",
  brand: { name: "TEREA", slug: "terea" },
  category: { name: "TEREA Japan", slug: "terea-japan" },
  description: "A rounded tobacco blend.\n\nFor IQOS ILUMA only.",
  variants: [{ priceFils: 12505, available: true }],
  soldOut: false,
  images: [{}],
  rating: null,
} as unknown as StoreProductResponse;

describe("search engine data (ADR 0114)", () => {
  it("cuts a description at a word, on one line", () => {
    expect(metaDescription("Short  text.\nSecond line.")).toBe("Short text. Second line.");
    const long = metaDescription("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(155);
    expect(long.endsWith("word…")).toBe(true);
  });

  it("describes a product with its price in AED from integer fils", () => {
    const data = productJsonLd(product, "https://shop.test");
    expect(data).toMatchObject({
      "@type": "Product",
      name: "TEREA Amber",
      url: "https://shop.test/p/terea-amber",
      image: ["https://shop.test/p/terea-amber/image"],
      brand: { name: "TEREA" },
      offers: {
        "@type": "Offer",
        price: "125.05",
        priceCurrency: "AED",
        availability: "https://schema.org/InStock",
      },
    });
    expect(data).not.toHaveProperty("aggregateRating");
  });

  it("gives a price range, sold-out state and rating when they apply", () => {
    const data = productJsonLd(
      {
        ...product,
        soldOut: true,
        images: [],
        rating: { average: 4.5, count: 2, distribution: [1, 1, 0, 0, 0] },
        variants: [{ priceFils: 9900 }, { priceFils: 10000 }],
      } as unknown as StoreProductResponse,
      "https://shop.test",
    );
    expect(data.offers).toMatchObject({
      "@type": "AggregateOffer",
      lowPrice: "99.00",
      highPrice: "100.00",
      offerCount: 2,
      availability: "https://schema.org/OutOfStock",
    });
    expect(data.aggregateRating).toMatchObject({ ratingValue: 4.5, reviewCount: 2 });
    expect(data).not.toHaveProperty("image");
  });

  it("lists the breadcrumb trail and never lets text close the script element", () => {
    const trail = breadcrumbJsonLd(
      [{ label: "Home", href: "/" }, { label: "TEREA </script>" }],
      "https://shop.test",
    );
    expect(trail.itemListElement[0]).toMatchObject({ position: 1, item: "https://shop.test/" });
    expect(trail.itemListElement[1]).not.toHaveProperty("item");
    expect(jsonLdText(trail)).not.toContain("</script>");
  });
});
