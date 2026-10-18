import type { Metadata } from "next";
import Link from "next/link";
import { BrandTile } from "@/components/home-sections";
import { Icon } from "@/components/icons";
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
        // The prototype's brand rail as a grid (`brandsPage`).
        <div className="brands brands-grid">
          {brands.map((brand) => (
            <BrandTile key={brand.slug} brand={brand} logo={brand.logo} />
          ))}
        </div>
      )}
      <section className="sec" aria-labelledby="by-type">
        <h2 className="h2 type-h" id="by-type">
          Shop by type
        </h2>
        <div className="cats">
          {(
            [
              [TYPE_PAGES.disposable, "var(--coral-soft)"],
              [TYPE_PAGES.kit, "var(--lagoon-soft)"],
            ] as const
          ).map(([page, tone]) => (
            <Link
              key={page.path}
              href={page.path}
              prefetch={false}
              className="cat type-cat"
              style={{ background: tone }}
            >
              <div>
                <h3>{page.title}</h3>
              </div>
              <span className="go" aria-hidden="true">
                <Icon name="arrow-r" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
