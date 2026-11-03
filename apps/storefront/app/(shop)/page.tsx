import type { Metadata } from "next";
import type { StoreHomeResponse } from "@ih/contracts";
import { HeroCarousel } from "@/components/hero-carousel";
import {
  CategoryTiles,
  HomeBanners,
  HomeBrands,
  HomeOffers,
  ProductSection,
} from "@/components/home-sections";
import { RecentlyViewed } from "@/components/recently-viewed";
import { SITE } from "@/lib/site";
import { TYPE_PAGES, type ListedType } from "@/lib/store/listing";
import { storeHome, storeRead } from "@/lib/store/server";

export const metadata: Metadata = { title: SITE.name };

/** Shown until the Owner publishes a hero: one navy slide with the store's own words. */
const DEFAULT_SLIDE: StoreHomeResponse["heroSlides"][number] = {
  style: "navy",
  eyebrow: "Delivery across the UAE",
  title: "IQOS devices and TEREA sticks, delivered.",
  subtitle: "Leading brands for adults. Pay cash when your order arrives.",
  cta: { label: "Shop now", href: "/shop" },
  secondaryCta: { label: "Browse brands", href: "/brands" },
  image: null,
  mobileImage: null,
};

/**
 * Home page (roadmap steps 64 and 99; the prototype's `home` since ADR 0097), laid out as a full
 * shop since ADR 0105 (client feedback 2026-11-03): the hero, categories, then products on every
 * row — best sellers, the two brands, new arrivals, featured, TEREA sticks and IQOS devices —
 * campaigns, offers and recently viewed. Published content (ADR 0066) and live catalogue
 * counts; a section with nothing to show is left out. Restricted like every page.
 */
export default async function HomePage() {
  const [content, [fresh, brands, counts, sticks, devices]] = await Promise.all([
    storeHome(),
    storeRead((api, shopper) =>
      Promise.all([
        api.products(shopper, { sort: "newest", limit: 8 }),
        api.brands(shopper),
        // Termless search: counts for the category tiles (catalogue budget, cached).
        api.search(shopper, [["limit", "1"]]),
        api.products(shopper, { type: "sticks", sort: "name", limit: 8 }),
        api.products(shopper, { type: "device", sort: "price_asc", limit: 8 }),
      ]),
    ),
  ]);
  const pictured = [
    ...fresh.items,
    ...content.bestSellers,
    ...content.featured,
    ...sticks.items,
    ...devices.items,
  ];
  const photo = (match: (card: (typeof pictured)[number]) => boolean) =>
    pictured.find((card) => card.image && match(card))?.image ?? null;
  const typeCount = (type: ListedType) =>
    counts.facets.types.find((item) => item.type === type)?.count ?? 0;
  const shownBrands = content.brands.length
    ? content.brands
    : brands.items
        .filter((brand) => brand.productCount > 0)
        .slice(0, 6)
        .map(({ name, slug, productCount }) => ({ name, slug, productCount }));
  /** A product photo for each brand's card (ADR 0105), from the products on this page. */
  const brandPhotos = Object.fromEntries(
    shownBrands.map((brand) => [brand.slug, photo((card) => card.brand.slug === brand.slug)]),
  );
  return (
    <>
      <HeroCarousel slides={content.heroSlides.length ? content.heroSlides : [DEFAULT_SLIDE]} />
      <CategoryTiles
        tiles={[
          {
            title: TYPE_PAGES.device.title,
            href: TYPE_PAGES.device.path,
            count: typeCount("device"),
            tone: "var(--coral-soft)",
            image: photo((card) => card.type === "device"),
          },
          {
            title: TYPE_PAGES.sticks.title,
            href: TYPE_PAGES.sticks.path,
            count: typeCount("sticks"),
            tone: "var(--lagoon-soft)",
            image: photo((card) => card.type === "sticks"),
          },
          {
            title: "New Arrivals",
            href: "/shop?sort=newest",
            count: null,
            tone: "var(--orchid-soft)",
            image: photo((card) => card.isNew),
          },
          {
            title: "Offers",
            href: "/offers",
            count: counts.facets.onSale,
            tone: "var(--saffron-soft)",
            image: photo((card) => card.compareAtPriceFils !== null),
          },
        ]}
      />
      <ProductSection
        id="best-h"
        title="Best sellers"
        sub="What other customers order most"
        products={content.bestSellers}
        more={{ label: "Shop all", href: "/shop" }}
      />
      <HomeBrands brands={shownBrands} logos={brands.items} photos={brandPhotos} />
      <ProductSection
        id="new-h"
        title="New arrivals"
        sub="Just added to the shop"
        products={fresh.items}
        more={{ label: "See everything new", href: "/shop?sort=newest" }}
      />
      <ProductSection
        id="feat-h"
        title="Featured"
        sub="Picked for you"
        products={content.featured}
        more={{ label: "Shop all", href: "/shop" }}
      />
      <ProductSection
        id="sticks-h"
        title={TYPE_PAGES.sticks.title}
        sub="Every TEREA edition, by flavour"
        products={sticks.items}
        more={{ label: "All TEREA sticks", href: TYPE_PAGES.sticks.path }}
      />
      <ProductSection
        id="devices-h"
        title={TYPE_PAGES.device.title}
        sub="IQOS ILUMA devices in every colour"
        products={devices.items}
        more={{ label: "All IQOS devices", href: TYPE_PAGES.device.path }}
      />
      <HomeBanners banners={content.banners} />
      <HomeOffers offers={content.offers} />
      <RecentlyViewed />
    </>
  );
}
