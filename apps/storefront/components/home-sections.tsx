import Link from "next/link";
import type { ReactNode } from "react";
import type { StoreBrandsResponse, StoreHomeResponse, StoreImage } from "@ih/contracts";
import { Icon } from "@/components/icons";
import { ProductRail } from "./product-card";

type Banner = StoreHomeResponse["banners"][number];

/** A sanitized content image (signed derivative link); the image optimizer is not used. */
function ContentImage({ image }: { image: StoreImage }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.urls.large}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading="lazy"
      decoding="async"
    />
  );
}

/** The prototype's "more" link (`moreLink`). */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} className="more">
      {children}
      <Icon name="arrow-r" />
    </Link>
  );
}

/** The prototype's section heading (`secHead`): title, optional line below, optional link. */
export function SectionHead({
  id,
  title,
  sub,
  more,
}: {
  id: string;
  title: string;
  sub?: string;
  more?: { label: string; href: string };
}) {
  return (
    <div className="sec-head">
      <div>
        <h2 className="h2" id={id}>
          {title}
        </h2>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {more && <MoreLink href={more.href}>{more.label}</MoreLink>}
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Shop by category" (prototype `catTiles`): four tiles with their product counts. */
export function CategoryTiles({
  tiles,
}: {
  tiles: ReadonlyArray<{
    title: string;
    href: string;
    count: number | null;
    tone: string;
    /** A product photo for the tile (the prototype draws product art there). */
    image: StoreImage | null;
  }>;
}) {
  return (
    <section className="sec" aria-labelledby="cat-h">
      <SectionHead id="cat-h" title="Shop by category" />
      <div className="cat4">
        {tiles.map((tile) => (
          <Link key={tile.href} href={tile.href} prefetch={false} className="c4">
            <span className="c4-img" style={{ background: tile.tone }} aria-hidden="true">
              {tile.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={tile.image.urls.medium} alt="" loading="lazy" decoding="async" />
              )}
            </span>
            <span className="c4-t">{tile.title}</span>
            <span className="c4-n">
              {tile.count === null ? "See what's new" : plural(tile.count, "product")}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** One brand (prototype `brandTile`): its logo when the Owner set one, else the name. */
export function BrandTile({
  brand,
  logo,
}: {
  brand: { name: string; slug: string; productCount: number };
  logo: StoreBrandsResponse["items"][number]["logo"];
}) {
  return (
    <Link href={`/brands/${brand.slug}`} prefetch={false} className="brand">
      <span className="stripe" aria-hidden="true" />
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="bw-logo" src={logo.urls.thumb} alt={brand.name} />
      ) : (
        <span className="bw">{brand.name}</span>
      )}
      <span>
        <span className="bc">{plural(brand.productCount, "product")}</span>
      </span>
    </Link>
  );
}

/** "Shop by brand" (prototype `brandTile`): the logo when the Owner set one, else the name. */
export function HomeBrands({
  brands,
  logos,
}: {
  brands: StoreHomeResponse["brands"];
  logos: StoreBrandsResponse["items"];
}) {
  if (!brands.length) return null;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby="br-h">
      <SectionHead
        id="br-h"
        title="Shop by brand"
        sub="Every brand we stock, in one place."
        more={{ label: "All brands", href: "/brands" }}
      />
      <div className="brands">
        {brands.map((brand) => (
          <BrandTile
            key={brand.slug}
            brand={brand}
            logo={logos.find((item) => item.slug === brand.slug)?.logo ?? null}
          />
        ))}
      </div>
    </section>
  );
}

/** Campaign banners (prototype `campaign`); never a coupon code (BI-13, Marina 2026-10-18). */
export function HomeBanners({ banners }: { banners: readonly Banner[] }) {
  if (!banners.length) return null;
  return (
    <>
      {banners.map((banner, index) => (
        <section
          key={index}
          className="sec"
          style={{ paddingTop: 0 }}
          aria-labelledby={`camp-h-${index}`}
        >
          <div className="camp">
            <div className="camp-copy">
              <h2 id={`camp-h-${index}`}>{banner.title}</h2>
              {banner.subtitle && <p>{banner.subtitle}</p>}
              {banner.cta && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <Link href={banner.cta.href} prefetch={false} className="btn btn-primary">
                    {banner.cta.label}
                  </Link>
                </div>
              )}
            </div>
            {banner.image && (
              <div className="camp-art">
                <ContentImage image={banner.image} />
              </div>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

/** Offers (prototype "Offers"): the products the Owner picked; hidden when there are none. */
export function HomeOffers({ offers }: { offers: StoreHomeResponse["offers"] }) {
  if (!offers || !offers.products.length) return null;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby="deal-h">
      <SectionHead
        id="deal-h"
        title={offers.title}
        sub={`${plural(offers.products.length, "product")} with a reduced price`}
        more={{ label: "View all offers", href: "/offers" }}
      />
      <ProductRail products={offers.products.slice(0, 4)} />
    </section>
  );
}

/** The prototype's puff-count bands (`PUFF`): up to 6,000, 6,000–12,000 and over 12,000. */
export const PUFF_BANDS = [
  { label: "≤6K", min: undefined, max: 6000 },
  { label: "6–12K", min: 6000, max: 12000 },
  { label: "12K+", min: 12001, max: undefined },
] as const;

/** "Disposables by puff count" (prototype home, parity G-S13): three bands with counts. */
export function PuffCounts({
  bands,
}: {
  bands: ReadonlyArray<{ label: string; href: string; count: number }>;
}) {
  if (!bands.some((band) => band.count > 0)) return null;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby="puff-h">
      <SectionHead
        id="puff-h"
        title="Disposables by puff count"
        sub="A quick way to choose how long a device lasts."
      />
      <div className="puffs">
        {bands.map((band, index) => (
          <Link key={band.href} href={band.href} prefetch={false} className="puff">
            <span className="bars" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((bar) => (
                <i
                  key={bar}
                  className={bar <= index * 2 + 1 ? "on" : undefined}
                  style={{ height: 8 + bar * 3.4 }}
                />
              ))}
            </span>
            <span className="n">{band.label}</span>
            <span className="l">{plural(band.count, "product")}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
