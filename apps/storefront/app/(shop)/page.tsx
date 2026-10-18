import type { Metadata } from "next";
import type { StoreHomeResponse } from "@ih/contracts";
import { HeroCarousel } from "@/components/hero-carousel";
import {
  CategoryTiles,
  HomeBanners,
  HomeBrands,
  HomeOffers,
  PUFF_BANDS,
  PuffCounts,
} from "@/components/home-sections";
import { PopularProducts, type PopularList } from "@/components/popular-products";
import { RecentlyViewed } from "@/components/recently-viewed";
import { SITE } from "@/lib/site";
import { TYPE_PAGES } from "@/lib/store/listing";
import { searchHref } from "@/lib/store/search";
import { storeHome, storeRead } from "@/lib/store/server";

export const metadata: Metadata = { title: SITE.name };

/** Shown until the Owner publishes a hero: one navy slide with the store's own words. */
const DEFAULT_SLIDE: StoreHomeResponse["heroSlides"][number] = {
  style: "navy",
  eyebrow: "Delivery across the UAE",
  title: "Disposable vapes and pod kits, delivered.",
  subtitle: "Leading brands for adults. Pay cash when your order arrives.",
  cta: { label: "Shop now", href: "/shop" },
  secondaryCta: { label: "Browse brands", href: "/brands" },
  image: null,
};

/**
 * Home page (roadmap steps 64 and 99; the prototype's `home` since ADR 0097): the hero
 * carousel, category tiles, popular lists, brands, campaigns, offers, puff-count bands and
 * recently viewed. Published content (ADR 0066) and live catalogue counts; a section with
 * nothing to show is left out. Restricted like every page.
 */
export default async function HomePage() {
  const [content, [fresh, brands, counts]] = await Promise.all([
    storeHome(),
    storeRead((api, shopper) =>
      Promise.all([
        api.products(shopper, { sort: "newest", limit: 8 }),
        api.brands(shopper),
        // Termless search: counts for the tiles and the puff bands (catalogue budget, cached).
        api.search(shopper, [["limit", "1"]]),
      ]),
    ),
  ]);
  const pictured = [...fresh.items, ...content.bestSellers, ...content.featured];
  const photo = (match: (card: (typeof pictured)[number]) => boolean) =>
    pictured.find((card) => card.image && match(card))?.image ?? null;
  const typeCount = (type: "disposable" | "kit") =>
    counts.facets.types.find((item) => item.type === type)?.count ?? 0;
  const shownBrands = content.brands.length
    ? content.brands
    : brands.items
        .filter((brand) => brand.productCount > 0)
        .slice(0, 6)
        .map(({ name, slug, productCount }) => ({ name, slug, productCount }));
  const popular: PopularList[] = [
    {
      key: "best",
      label: "Best sellers",
      products: content.bestSellers,
      more: { label: "Shop all best sellers", href: "/shop" },
    },
    {
      key: "featured",
      label: "Featured",
      products: content.featured,
      more: { label: "Shop all products", href: "/shop" },
    },
    {
      key: "new",
      label: "New in",
      products: fresh.items,
      more: { label: "See everything new", href: "/shop?sort=newest" },
    },
  ].filter((list) => list.products.length > 0);
  const puffBands = PUFF_BANDS.map((band) => ({
    label: band.label,
    href: searchHref(
      {
        ...(band.min !== undefined ? { minPuffs: band.min } : {}),
        ...(band.max !== undefined ? { maxPuffs: band.max } : {}),
      },
      TYPE_PAGES.disposable.path,
    ),
    count: counts.facets.puffCounts
      .filter(
        (item) =>
          (band.min === undefined || item.puffCount >= band.min) &&
          (band.max === undefined || item.puffCount <= band.max),
      )
      .reduce((sum, item) => sum + item.count, 0),
  }));
  return (
    <>
      <HeroCarousel slides={content.heroSlides.length ? content.heroSlides : [DEFAULT_SLIDE]} />
      <CategoryTiles
        tiles={[
          {
            title: "Disposable Vapes",
            href: TYPE_PAGES.disposable.path,
            count: typeCount("disposable"),
            tone: "var(--coral-soft)",
            image: photo((card) => card.type === "disposable"),
          },
          {
            title: "Vape Kits",
            href: TYPE_PAGES.kit.path,
            count: typeCount("kit"),
            tone: "var(--lagoon-soft)",
            image: photo((card) => card.type === "kit"),
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
      <PopularProducts lists={popular} />
      <HomeBrands brands={shownBrands} logos={brands.items} />
      <HomeBanners banners={content.banners} />
      <HomeOffers offers={content.offers} />
      <PuffCounts bands={puffBands} />
      <RecentlyViewed />
    </>
  );
}
