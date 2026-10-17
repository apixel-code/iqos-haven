import type { Metadata } from "next";
import Link from "next/link";
import { HomeBanners, HomeBrands, HomeHero, HomeOffers } from "@/components/home-sections";
import { PopularProducts, type PopularList } from "@/components/popular-products";
import { RecentlyViewed } from "@/components/recently-viewed";
import { SITE } from "@/lib/site";
import { TYPE_PAGES } from "@/lib/store/listing";
import { storeHome, storeRead } from "@/lib/store/server";

export const metadata: Metadata = { title: SITE.name };

const sectionHead = "text-xl font-semibold tracking-tight";

/**
 * Home page (roadmap steps 64 and 99): published content from the API (ADR 0066) around live
 * catalogue sections, in the prototype's order. Content that is not published, switched off
 * or no longer visible is simply absent; the catalogue sections fill in (new arrivals, brands
 * with products). Restricted like every page.
 */
export default async function HomePage() {
  const [content, [fresh, brands]] = await Promise.all([
    storeHome(),
    storeRead((api, shopper) =>
      Promise.all([api.products(shopper, { sort: "newest", limit: 8 }), api.brands(shopper)]),
    ),
  ]);
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
      more: { label: "Shop all products", href: "/shop" },
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
      more: { label: "See everything new", href: "/shop" },
    },
  ].filter((list) => list.products.length > 0);
  return (
    <div className="flex flex-col gap-12">
      <HomeHero hero={content.hero} storeName={SITE.name} />
      <section aria-labelledby="home-categories" className="flex flex-col gap-4">
        <h2 id="home-categories" className={sectionHead}>
          Shop by category
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              [TYPE_PAGES.disposable, "bg-coral-soft"],
              [TYPE_PAGES.kit, "bg-lagoon-soft"],
            ] as const
          ).map(([page, tone]) => (
            <li key={page.path}>
              <Link
                href={page.path}
                prefetch={false}
                className={`flex min-h-[140px] items-end justify-between gap-3 rounded-md p-5 text-lg font-semibold ${tone} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
              >
                {page.title}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <PopularProducts lists={popular} />
      <HomeBrands brands={shownBrands} />
      <HomeBanners banners={content.banners} />
      <HomeOffers offers={content.offers} />
      <RecentlyViewed />
    </div>
  );
}
