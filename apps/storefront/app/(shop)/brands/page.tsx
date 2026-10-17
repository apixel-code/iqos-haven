import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, EmptyState, PageHead } from "@/components/listing";
import { TYPE_PAGES } from "@/lib/store/listing";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = { title: `Brands · ${SITE.name}` };

/** Brands index (prototype `brandsPage`): a tile per brand, then the two product types. */
export default async function BrandsPage() {
  const { items } = await storeRead((api, shopper) => api.brands(shopper));
  const brands = items.filter((brand) => brand.productCount > 0);
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Brands" }]} />
      <PageHead
        title="Brands"
        lead={`${brands.length} ${brands.length === 1 ? "brand" : "brands"}.`}
      />
      {brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          body="Brands will appear here as soon as their products are available."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {brands.map((brand) => (
            <li key={brand.slug}>
              <Link
                href={`/brands/${brand.slug}`}
                prefetch={false}
                className="flex min-h-[92px] flex-col justify-between gap-2 rounded-md border border-line bg-surface px-3.5 py-3 transition-[transform,box-shadow,border-color] duration-150 ease-brand hover:-translate-y-0.5 hover:border-ink hover:shadow-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {brand.logo ? (
                  // Signed link to a sanitized derivative; the Next image optimizer is not used.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={brand.logo.urls.thumb}
                    alt=""
                    width={brand.logo.width}
                    height={brand.logo.height}
                    className="h-8 w-auto max-w-24 object-contain object-left"
                  />
                ) : (
                  <span aria-hidden="true" className="h-[3px] w-[22px] rounded-pill bg-accent" />
                )}
                <span className="text-[17px] font-semibold leading-tight">{brand.name}</span>
                <span className="font-mono text-[10.5px] text-ink-2">
                  {brand.productCount} {brand.productCount === 1 ? "product" : "products"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="by-type" className="flex flex-col gap-4 pt-10">
        <h2 id="by-type" className="text-xl font-semibold tracking-tight">
          Shop by type
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
    </>
  );
}
