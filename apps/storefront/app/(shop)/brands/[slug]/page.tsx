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
        // The prototype's brand header (`bhero`). The prototype's "from" price is left out: the
        // brand read carries no lowest price, and a guessed one could be wrong.
        <header className="bhero">
          <div className="bhero-t">
            {brand.logo && (
              // Signed link to a sanitized derivative; the Next image optimizer is not used.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="bhero-logo"
                src={brand.logo.urls.medium}
                alt={brand.logo.alt}
                width={brand.logo.width}
                height={brand.logo.height}
              />
            )}
            <span className="eyebrow">Brand</span>
            <h1 className="bw">{brand.name}</h1>
            {brand.description && <p className="muted bhero-d">{brand.description}</p>}
          </div>
          <div className="stats">
            <span>
              <b>{brand.productCount}</b>
              {brand.productCount === 1 ? "product" : "products"}
            </span>
          </div>
        </header>
      }
      emptyBody="This brand has no products available right now."
    />
  );
}
