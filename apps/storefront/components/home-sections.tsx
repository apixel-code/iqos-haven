import Link from "next/link";
import type { ReactNode } from "react";
import type {
  StoreBrandsResponse,
  StoreHomeResponse,
  StoreImage,
  StoreProductCard,
} from "@ih/contracts";
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

/**
 * One row of products on the home page (ADR 0105): heading, a line below, the products (a
 * swipeable row on phones, a grid of four from 1040 px) and a link to the full list. Left out
 * when there is nothing to show.
 */
export function ProductSection({
  id,
  title,
  sub,
  products,
  more,
}: {
  id: string;
  title: string;
  sub: string;
  products: readonly StoreProductCard[];
  more: { label: string; href: string };
}) {
  if (!products.length) return null;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby={id}>
      <SectionHead id={id} title={title} sub={sub} more={more} />
      <ProductRail products={products.slice(0, 8)} />
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

/** A brand's first sentence, for its card; the full text is on the brand page. */
const firstSentence = (text: string) => {
  const sentence = text.trim().split(/(?<=[.!?])\s/u)[0] ?? "";
  return sentence.length > 110 ? `${sentence.slice(0, 107).trimEnd()}…` : sentence;
};

/**
 * "Shop by brand" (client feedback 2026-11-03, ADR 0105): the store carries two brands, IQOS
 * and TEREA, so each gets a wide card with its logo or name, a line about it, a product photo
 * and its own button, instead of the prototype's row of small tiles. More brands fall back to
 * the tiles.
 */
export function HomeBrands({
  brands,
  logos,
  photos,
}: {
  brands: StoreHomeResponse["brands"];
  logos: StoreBrandsResponse["items"];
  /** A product photo per brand slug, from the products on this page. */
  photos: Readonly<Record<string, StoreImage | null>>;
}) {
  if (!brands.length) return null;
  const showcase = brands.length <= 2;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby="br-h">
      <SectionHead
        id="br-h"
        title="Shop by brand"
        more={showcase ? undefined : { label: "All brands", href: "/brands" }}
      />
      {showcase ? (
        <div className="bshow">
          {brands.map((brand, index) => {
            const about = logos.find((item) => item.slug === brand.slug);
            const photo = photos[brand.slug] ?? null;
            return (
              <Link
                key={brand.slug}
                href={`/brands/${brand.slug}`}
                prefetch={false}
                className={`bshow-card ${index === 0 ? "dark" : "light"}${photo ? "" : " no-art"}`}
              >
                <span className="bshow-copy">
                  {about?.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="bshow-logo" src={about.logo.urls.thumb} alt={brand.name} />
                  ) : (
                    <span className="bshow-name">{brand.name}</span>
                  )}
                  {about?.description && (
                    <span className="bshow-about">{firstSentence(about.description)}</span>
                  )}
                  <span className="bshow-count">{plural(brand.productCount, "product")}</span>
                  <span className="bshow-cta">
                    Shop {brand.name} <Icon name="arrow-r" size="sm" />
                  </span>
                </span>
                {photo && (
                  <span className="bshow-art" aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.urls.medium} alt="" loading="lazy" decoding="async" />
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="brands">
          {brands.map((brand) => (
            <BrandTile
              key={brand.slug}
              brand={brand}
              logo={logos.find((item) => item.slug === brand.slug)?.logo ?? null}
            />
          ))}
        </div>
      )}
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

/**
 * The prototype's puff-count bands (`PUFF`): up to 6,000, 6,000–12,000 and over 12,000. Only the
 * shop filters use them now, for vape products stored before ADR 0101; the home page section
 * "Disposables by puff count" was removed with the heated-tobacco catalogue.
 */
export const PUFF_BANDS = [
  { label: "≤6K", min: undefined, max: 6000 },
  { label: "6–12K", min: 6000, max: 12000 },
  { label: "12K+", min: 12001, max: undefined },
] as const;
