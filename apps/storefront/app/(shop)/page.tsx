import type { Metadata } from "next";
import {
  STORE_PAGE_SIZES,
  type StoreCategoriesResponse,
  type StoreHomeResponse,
  type StoreProductCard,
} from "@ih/contracts";
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

type Card = StoreProductCard;

/**
 * The TEREA row shows different flavours: with one product per flavour and country (ADR 0110)
 * the name order would fill it with one flavour from four countries.
 */
function oneOfEachFlavour(cards: readonly Card[]) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const flavour = card.name.split(" – ")[0]!.trim().toLowerCase();
    if (seen.has(flavour)) return false;
    seen.add(flavour);
    return true;
  });
}
type Category = StoreCategoriesResponse["items"][number];

/**
 * One home row of four per TEREA country category (client request 2026-11-08, ADR 0110), in
 * the admin's category order: the categories whose slug starts with `terea-` and that hold
 * products on sale. The cards come from the page of sticks already read; a country that page
 * does not fully cover (more sticks than one page) is read on its own.
 */
async function tereaCountryRows(categories: readonly Category[], sticks: readonly Card[]) {
  const countries = categories.filter((c) => c.slug.startsWith("terea-") && c.productCount > 0);
  const rows = countries.map((category) => ({
    name: category.name,
    slug: category.slug,
    count: category.productCount,
    products: sticks.filter((card) => card.category.slug === category.slug).slice(0, 4),
  }));
  const short = rows.filter((row) => row.products.length < Math.min(4, row.count));
  if (short.length) {
    const pages = await storeRead((api, shopper) =>
      Promise.all(
        short.map((row) => api.products(shopper, { category: row.slug, sort: "name", limit: 4 })),
      ),
    );
    short.forEach((row, index) => (row.products = pages[index]!.items));
  }
  return rows.filter((row) => row.products.length);
}

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
 * row — best sellers, the two brands, new arrivals, featured, TEREA sticks, one row per TEREA
 * country and IQOS devices —
 * campaigns, offers and recently viewed. Published content (ADR 0066) and live catalogue
 * counts; a section with nothing to show is left out. Restricted like every page.
 */
export default async function HomePage() {
  const [content, [fresh, brands, counts, sticks, devices, categories]] = await Promise.all([
    storeHome(),
    storeRead((api, shopper) =>
      Promise.all([
        api.products(shopper, { sort: "newest", limit: 8 }),
        api.brands(shopper),
        // Termless search: counts for the category tiles (catalogue budget, cached).
        api.search(shopper, [["limit", "1"]]),
        // One page of sticks feeds the TEREA row and the country rows below it.
        api.products(shopper, { type: "sticks", sort: "name", limit: STORE_PAGE_SIZES.max }),
        api.products(shopper, { type: "device", sort: "price_asc", limit: 4 }),
        api.categories(shopper),
      ]),
    ),
  ]);
  const countryRows = await tereaCountryRows(categories.items, sticks.items);
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
        products={oneOfEachFlavour(sticks.items)}
        limit={4}
        more={{ label: "All TEREA sticks", href: TYPE_PAGES.sticks.path }}
      />
      {countryRows.map((row) => (
        <ProductSection
          key={row.slug}
          id={`cat-${row.slug}-h`}
          title={row.name}
          sub={`${row.count} ${row.count === 1 ? "flavour" : "flavours"}`}
          products={row.products}
          limit={4}
          more={{ label: "See all", href: `/categories/${row.slug}` }}
        />
      ))}
      <ProductSection
        id="devices-h"
        title={TYPE_PAGES.device.title}
        sub="IQOS ILUMA devices in every colour"
        products={devices.items}
        limit={4}
        more={{ label: "All IQOS devices", href: TYPE_PAGES.device.path }}
      />
      <HomeBanners banners={content.banners} />
      <HomeOffers offers={content.offers} />
      <RecentlyViewed />
    </>
  );
}
