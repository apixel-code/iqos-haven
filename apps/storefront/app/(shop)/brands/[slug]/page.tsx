import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";
import { ListingPage } from "../../listing-page";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** The brand a shopper may see under this slug, or null. Only listed brands have a page. */
async function brandOf(slug: string) {
  const { items } = await storeRead((api, shopper) => api.brands(shopper));
  // A former slug finds the brand too; the page then sends it to the current one (step 101).
  return (
    items.find((brand) => brand.slug === slug) ??
    items.find((brand) => brand.formerSlugs.includes(slug)) ??
    null
  );
}

// Runs only for requests the routing gate let through, so the brand name is safe in the title.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const brand = await brandOf((await params).slug);
  if (!brand) return { title: SITE.name };
  return {
    title: `${brand.name} · ${SITE.name}`,
    alternates: { canonical: `/brands/${brand.slug}` },
  };
}

export default async function BrandPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const brand = await brandOf(slug);
  if (!brand) notFound();
  if (brand.slug !== slug) permanentRedirect(`/brands/${brand.slug}`);
  return (
    <ListingPage
      path={`/brands/${brand.slug}`}
      searchParams={searchParams}
      fixed={{ brand: brand.slug }}
      trail={[
        { label: "Home", href: "/" },
        { label: "Brands", href: "/brands" },
        { label: brand.name },
      ]}
      head={
        <header className="my-4 grid gap-4 rounded-lg bg-accent-soft p-6 md:grid-cols-[1fr_auto] md:items-end md:px-10 md:py-9">
          <div className="flex flex-col gap-2">
            {brand.logo && (
              // Signed link to a sanitized derivative; the Next image optimizer is not used.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logo.urls.medium}
                alt={brand.logo.alt}
                width={brand.logo.width}
                height={brand.logo.height}
                className="h-16 w-auto max-w-48 object-contain"
              />
            )}
            <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-2">Brand</p>
            <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">{brand.name}</h1>
            {brand.description && (
              <p className="max-w-2xl whitespace-pre-line text-sm text-ink-2">
                {brand.description}
              </p>
            )}
          </div>
          <p className="text-sm text-ink-2">
            <b className="block text-2xl font-semibold text-ink">{brand.productCount}</b>
            {brand.productCount === 1 ? "product" : "products"}
          </p>
        </header>
      }
      emptyBody="This brand has no products available right now."
    />
  );
}
