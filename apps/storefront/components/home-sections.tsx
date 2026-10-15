import Link from "next/link";
import type { StoreHomeResponse, StoreImage } from "@ih/contracts";
import { ProductGrid } from "./product-card";

type Hero = NonNullable<StoreHomeResponse["hero"]>;
type Banner = StoreHomeResponse["banners"][number];

const sectionHead = "text-[clamp(21px,3.6vw,28px)] font-semibold tracking-tight";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** A sanitized content image (signed derivative link); the image optimizer is not used. */
function ContentImage({
  image,
  className,
  priority = false,
}: {
  image: StoreImage;
  className: string;
  /** The hero image is the page's largest element: fetch it first. */
  priority?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.urls.large}
      alt={image.alt}
      width={image.width}
      height={image.height}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      className={className}
    />
  );
}

/**
 * Hero (roadmap step 99; prototype `heroBanner`, one slide). Text and button come from
 * published content as plain text; the button only ever points inside the store. Without a
 * published hero the generic store hero is shown.
 */
export function HomeHero({ hero, storeName }: { hero: Hero | null; storeName: string }) {
  const title = hero?.title ?? storeName;
  const subtitle = hero
    ? hero.subtitle
    : "Disposable vapes and vape kits for adults. Pay cash when your order arrives.";
  const cta = hero ? hero.cta : { label: "Shop all products", href: "/shop" };
  return (
    <section
      aria-labelledby="home-title"
      className="relative isolate -mx-4 min-h-[300px] overflow-hidden bg-chrome px-5 pb-12 pt-6 text-chrome-ink sm:-mx-8 sm:px-11 sm:pb-16 sm:pt-9 md:min-h-[360px]"
    >
      <span
        aria-hidden="true"
        className="absolute -bottom-40 -right-28 -z-10 size-[300px] rounded-full bg-accent opacity-90 md:-right-24 md:-top-20 md:bottom-auto md:size-[420px]"
      />
      <div className="relative flex flex-col items-start gap-2.5 md:max-w-[52%] md:gap-4">
        {hero?.eyebrow && (
          <span className="inline-flex h-7 items-center rounded-pill bg-white/15 px-3 text-xs font-semibold uppercase tracking-[0.06em]">
            {hero.eyebrow}
          </span>
        )}
        <h1
          id="home-title"
          className={`${hero?.image ? "max-w-[62%]" : "max-w-[85%]"} text-[26px] font-semibold leading-[1.05] tracking-[-0.035em] text-balance sm:max-w-none sm:text-[clamp(30px,5vw,50px)]`}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="hidden max-w-[40ch] text-[15px] leading-normal opacity-[0.82] sm:block">
            {subtitle}
          </p>
        )}
        {cta && (
          <Link
            href={cta.href}
            prefetch={false}
            className={`mt-1 inline-flex h-12 items-center gap-2 rounded-pill bg-surface px-6 text-base font-medium text-ink hover:bg-surface-2 ${focus}`}
          >
            {cta.label} <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
      {hero?.image && (
        <div className="pointer-events-none absolute bottom-0 right-0 h-[62%] w-[56%] md:inset-y-0 md:h-full md:w-[46%]">
          <ContentImage image={hero.image} className="size-full object-cover" priority />
        </div>
      )}
    </section>
  );
}

function SectionHead({
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
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 id={id} className={sectionHead}>
          {title}
        </h2>
        {sub && <p className="mt-1.5 text-sm text-ink-3">{sub}</p>}
      </div>
      {more && (
        <Link href={more.href} prefetch={false} className="text-sm font-medium hover:underline">
          {more.label} <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}

/** "Shop by brand" (prototype `brandTile`): a rail on phones, 3 then 6 columns. */
export function HomeBrands({ brands }: { brands: StoreHomeResponse["brands"] }) {
  if (!brands.length) return null;
  return (
    <section aria-labelledby="home-brands" className="flex flex-col gap-5">
      <SectionHead
        id="home-brands"
        title="Shop by brand"
        sub="Every brand we stock, in one place."
        more={{ label: "All brands", href: "/brands" }}
      />
      <ul className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-3.5 sm:overflow-visible sm:px-0 xl:grid-cols-6">
        {brands.map((brand) => (
          <li key={brand.slug} className="min-w-[118px] basis-[32%] snap-start sm:min-w-0">
            <Link
              href={`/brands/${brand.slug}`}
              prefetch={false}
              className={`flex min-h-[92px] flex-col justify-center gap-1 rounded-md border border-line bg-surface px-3.5 py-3 transition-transform hover:-translate-y-0.5 hover:border-ink ${focus}`}
            >
              <span className="text-[17px] font-semibold">{brand.name}</span>
              <span className="font-mono text-[10.5px] text-ink-2">
                {brand.productCount} {brand.productCount === 1 ? "product" : "products"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Campaign banners (prototype `campaign`), copy first, image beside it from 720px up. */
export function HomeBanners({ banners }: { banners: readonly Banner[] }) {
  if (!banners.length) return null;
  return (
    <div className="flex flex-col gap-4">
      {banners.map((banner, index) => (
        <section
          key={index}
          aria-labelledby={`home-banner-${index}`}
          className={`grid overflow-hidden rounded-lg bg-ink text-surface ${banner.image ? "md:grid-cols-[1.2fr_1fr]" : ""}`}
        >
          <div className="flex flex-col items-start gap-3.5 px-[22px] py-7 md:p-11">
            <h2
              id={`home-banner-${index}`}
              className="text-[clamp(26px,5vw,40px)] font-semibold leading-[1.08] tracking-[-0.03em]"
            >
              {banner.title}
            </h2>
            {banner.subtitle && <p className="max-w-[40ch] text-surface/80">{banner.subtitle}</p>}
            {banner.cta && (
              <Link
                href={banner.cta.href}
                prefetch={false}
                className={`inline-flex h-12 items-center rounded-pill bg-surface px-6 font-medium text-ink hover:bg-surface-2 ${focus}`}
              >
                {banner.cta.label}
              </Link>
            )}
          </div>
          {banner.image && (
            <div className="relative min-h-[220px] bg-accent">
              <ContentImage
                image={banner.image}
                className="absolute inset-0 size-full object-cover"
              />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Offers (prototype "Offers"): the products the Owner picked; hidden when there are none. */
export function HomeOffers({ offers }: { offers: StoreHomeResponse["offers"] }) {
  if (!offers || !offers.products.length) return null;
  return (
    <section aria-labelledby="home-offers" className="flex flex-col gap-5">
      <SectionHead id="home-offers" title={offers.title} />
      <ProductGrid products={offers.products} />
    </section>
  );
}
