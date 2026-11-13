import type { StoreProductResponse } from "@ih/contracts";

/**
 * What a catalogue page tells a search engine about itself (ADR 0114): the description under a
 * search result and the page's structured data. Pure builders; the pages decide when to use
 * them (structured data only while the Owner offers the catalogue).
 */

/** One plain line of at most `max` characters, cut at a word, for a meta description. */
export function metaDescription(text: string, max = 155): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
}

/** Integer fils as a decimal amount ("12500" fils → "125.00"); no floating point. */
const amount = (fils: number) => `${Math.floor(fils / 100)}.${String(fils % 100).padStart(2, "0")}`;

/** schema.org Product with its offer. Prices are the store's own, in AED. */
export function productJsonLd(product: StoreProductResponse, origin: string) {
  const url = new URL(`/p/${product.slug}`, origin).toString();
  const prices = product.variants.map((variant) => variant.priceFils);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const availability = `https://schema.org/${product.soldOut ? "OutOfStock" : "InStock"}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: metaDescription(product.description, 500),
    url,
    brand: { "@type": "Brand", name: product.brand.name },
    category: product.category.name,
    // A stable address: the storage links on the page are signed and expire.
    ...(product.images.length ? { image: [`${url}/image`] } : {}),
    ...(product.rating
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: product.rating.average,
            reviewCount: product.rating.count,
          },
        }
      : {}),
    offers:
      low === high
        ? {
            "@type": "Offer",
            url,
            price: amount(low),
            priceCurrency: "AED",
            availability,
            itemCondition: "https://schema.org/NewCondition",
          }
        : {
            "@type": "AggregateOffer",
            url,
            lowPrice: amount(low),
            highPrice: amount(high),
            offerCount: prices.length,
            priceCurrency: "AED",
            availability,
          },
  };
}

/** schema.org BreadcrumbList from a page's trail; the last entry is the page itself. */
export function breadcrumbJsonLd(
  trail: ReadonlyArray<{ label: string; href?: string }>,
  origin: string,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.label,
      ...(entry.href ? { item: new URL(entry.href, origin).toString() } : {}),
    })),
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so text can never end the element. */
export const jsonLdText = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
