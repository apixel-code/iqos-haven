import Link from "next/link";
import type { StoreProductCard } from "@ih/contracts";
import { cardBadges, cardMeta, displayAed } from "@/lib/store/listing";

const BADGE_STYLES = {
  soldOut: "bg-ink text-white",
  sale: "bg-coral text-white",
  new: "bg-accent text-ink",
} as const;

/**
 * Product card (prototype `card`): the image tile is the only surface; the name link covers the
 * whole card. Price is "from" the lowest option. A sold-out product stays listed, dimmed.
 */
export function ProductCard({ product }: { product: StoreProductCard }) {
  const badges = cardBadges(product);
  const onSale = badges.some((badge) => badge.kind === "sale");
  return (
    <article className="group relative flex flex-col gap-3">
      <div className="relative aspect-[4/5] overflow-hidden rounded-md bg-surface-2">
        {product.image ? (
          // Signed, short-lived link straight to a sanitized derivative; the Next image
          // optimizer is not used for catalogue images.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image.urls.medium}
            alt={product.image.alt}
            width={product.image.width}
            height={product.image.height}
            loading="lazy"
            decoding="async"
            className={`size-full object-cover transition-transform duration-200 ease-brand group-hover:scale-[1.025] ${
              product.soldOut ? "opacity-45 grayscale-[0.6]" : ""
            }`}
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex size-full items-center justify-center px-3 text-center text-xs text-ink-3"
          >
            {product.brand.name}
          </div>
        )}
        {badges.length > 0 && (
          <ul className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <li
                key={badge.kind}
                className={`rounded-pill px-2 py-0.5 text-[11.5px] font-semibold ${BADGE_STYLES[badge.kind]}`}
              >
                {badge.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{product.brand.name}</p>
        <h3 className="line-clamp-2 text-[15px] font-medium">
          {/* prefetch off: a prefetch would spend the shopper's read budget on pages not opened. */}
          <Link
            href={`/p/${product.slug}`}
            prefetch={false}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-focus"
          >
            {product.name}
          </Link>
        </h3>
        <p className="truncate font-mono text-[12.5px] text-ink-3">{cardMeta(product)}</p>
        <p className="mt-1.5 flex min-h-10 flex-wrap items-baseline gap-x-2">
          <span className={`text-base font-semibold ${onSale ? "text-coral" : ""}`}>
            {product.variantCount > 1 && <span className="sr-only">From </span>}
            {displayAed(product.priceFromFils)}
          </span>
          {product.compareAtPriceFils !== null && (
            <span className="text-[13.5px] text-ink-3 line-through">
              <span className="sr-only">Was </span>
              {displayAed(product.compareAtPriceFils)}
            </span>
          )}
        </p>
      </div>
    </article>
  );
}

/** Grid from the prototype: two columns on phones, up to four on wide screens. */
export function ProductGrid({ products }: { products: readonly StoreProductCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-[22px] md:grid-cols-3 md:gap-x-[18px] md:gap-y-8 xl:grid-cols-4">
      {products.map((product) => (
        <li key={product.slug}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}

/** Loading placeholder with the card's proportions (prototype `skCards`). */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading products"
      className="grid grid-cols-2 gap-x-3 gap-y-[22px] md:grid-cols-3 md:gap-x-[18px] md:gap-y-8 xl:grid-cols-4"
    >
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="flex animate-pulse flex-col gap-3">
          <div className="aspect-[4/5] rounded-md bg-surface-2" />
          <div className="h-3 w-2/5 rounded-xs bg-surface-2" />
          <div className="h-3 w-4/5 rounded-xs bg-surface-2" />
          <div className="h-3 w-[30%] rounded-xs bg-surface-2" />
        </li>
      ))}
    </ul>
  );
}
