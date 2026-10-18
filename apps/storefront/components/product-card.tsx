import Link from "next/link";
import type { StoreProductCard } from "@ih/contracts";
import { Dirham } from "@/components/money";
import { cardBadges, cardMeta, displayAmount } from "@/lib/store/listing";
import { QuickAdd } from "./quick-add";
import { SaveButton } from "./save-button";

const BADGE_CLASS = {
  soldOut: "badge badge-oos",
  sale: "badge badge-sale",
  new: "badge badge-new",
};

/**
 * Product card (prototype `card`, ADR 0097): the image tile, badges and heart, then the name
 * (its link covers the card), the short spec line, the price "from" the lowest option and the
 * quick-add button. A sold-out product stays listed, dimmed, without the button.
 */
export function ProductCard({ product }: { product: StoreProductCard }) {
  const badges = cardBadges(product);
  const onSale = badges.some((badge) => badge.kind === "sale");
  const href = `/p/${product.slug}`;
  return (
    <article className={product.soldOut ? "card oos" : "card"}>
      {/* prefetch off: a prefetch would spend the shopper's read budget on pages not opened. */}
      <Link href={href} prefetch={false} className="art" tabIndex={-1} aria-hidden="true">
        {product.image ? (
          // Signed, short-lived link straight to a sanitized derivative; the Next image
          // optimizer is not used for catalogue images.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image.urls.medium}
            alt=""
            width={product.image.width}
            height={product.image.height}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="art-empty">{product.brand.name}</span>
        )}
      </Link>
      {badges.length > 0 && (
        <div className="badges">
          {badges.map((badge) => (
            <span key={badge.kind} className={BADGE_CLASS[badge.kind]}>
              {badge.label}
            </span>
          ))}
        </div>
      )}
      <SaveButton
        slug={product.slug}
        name={product.name}
        image={product.image?.urls.thumb ?? null}
      />
      <div className="info">
        <span className="brandname">{product.brand.name}</span>
        <Link href={href} prefetch={false} className="name">
          {product.name}
        </Link>
        <span className="meta">{cardMeta(product)}</span>
        <div className="card-foot">
          <div className="price">
            <span className={onSale ? "now sale" : "now"}>
              {product.variantCount > 1 && <span className="sr">From </span>}
              <Dirham />
              {displayAmount(product.priceFromFils)}
            </span>
            {product.compareAtPriceFils !== null && (
              <span className="was">
                <span className="sr">Was </span>
                <Dirham />
                {displayAmount(product.compareAtPriceFils)}
              </span>
            )}
          </div>
          {!product.soldOut && <QuickAdd slug={product.slug} name={product.name} />}
        </div>
      </div>
    </article>
  );
}

/** The prototype's product grid: two columns on phones, three, then four. */
export function ProductGrid({ products }: { products: readonly StoreProductCard[] }) {
  return (
    <ul className="pgrid">
      {products.map((product) => (
        <li key={product.slug}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}

/** The prototype's horizontal rail: swipe on phones, four across on wide screens. */
export function ProductRail({ products }: { products: readonly StoreProductCard[] }) {
  return (
    <ul className="rail">
      {products.map((product) => (
        <li key={product.slug}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}

/** Loading placeholder with the card's proportions (prototype `skCards`, parity G-S7). */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="pgrid" aria-busy="true" aria-label="Loading products">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="sk-card" aria-hidden="true">
          <div className="sk a" />
          <div className="sk l" style={{ width: "40%" }} />
          <div className="sk l" style={{ width: "80%" }} />
          <div className="sk l" style={{ width: "30%" }} />
        </div>
      ))}
    </div>
  );
}
