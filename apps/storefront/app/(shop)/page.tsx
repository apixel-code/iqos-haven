import type { Metadata } from "next";
import Link from "next/link";
import { ProductGrid } from "@/components/product-card";
import { RecentlyViewed } from "@/components/recently-viewed";
import { SITE } from "@/lib/site";
import { TYPE_PAGES } from "@/lib/store/listing";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = { title: SITE.name };

const sectionHead = "text-xl font-semibold tracking-tight";

/**
 * Home shell (roadmap step 64): the frame of the home page with live catalogue data. The hero,
 * promotions and editorial sections are managed content and arrive with the content module
 * (step 97); until then the page leads straight into the catalogue. Restricted like every page.
 */
export default async function HomePage() {
  const [fresh, brands] = await storeRead((api, shopper) =>
    Promise.all([api.products(shopper, { sort: "newest", limit: 8 }), api.brands(shopper)]),
  );
  const shownBrands = brands.items.filter((brand) => brand.productCount > 0).slice(0, 6);
  return (
    <div className="flex flex-col gap-12 pt-8">
      <section
        aria-labelledby="home-title"
        className="flex flex-col gap-3 rounded-lg bg-accent-soft p-6 md:p-10"
      >
        <h1 id="home-title" className="text-4xl font-semibold tracking-tight md:text-5xl">
          {SITE.name}
        </h1>
        <p className="max-w-xl text-base text-ink-2">
          Disposable vapes and vape kits for adults in Dubai. Pay cash when your order arrives.
        </p>
        <Link
          href="/shop"
          prefetch={false}
          className="mt-2 inline-flex h-12 w-fit items-center rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Shop all products
        </Link>
      </section>

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

      {fresh.items.length > 0 && (
        <section aria-labelledby="home-new" className="flex flex-col gap-5">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="home-new" className={sectionHead}>
              New in
            </h2>
            <Link href="/shop" prefetch={false} className="text-sm underline underline-offset-2">
              View all
            </Link>
          </div>
          <ProductGrid products={fresh.items} />
        </section>
      )}

      {shownBrands.length > 0 && (
        <section aria-labelledby="home-brands" className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="home-brands" className={sectionHead}>
              Shop by brand
            </h2>
            <Link href="/brands" prefetch={false} className="text-sm underline underline-offset-2">
              All brands
            </Link>
          </div>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {shownBrands.map((brand) => (
              <li key={brand.slug}>
                <Link
                  href={`/brands/${brand.slug}`}
                  prefetch={false}
                  className="flex min-h-[72px] flex-col justify-center gap-1 rounded-md border border-line bg-surface px-3.5 py-3 hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="font-semibold">{brand.name}</span>
                  <span className="font-mono text-[10.5px] text-ink-2">
                    {brand.productCount} {brand.productCount === 1 ? "product" : "products"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RecentlyViewed />
    </div>
  );
}
