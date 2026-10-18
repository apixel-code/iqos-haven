"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { useStoreBrands } from "@/lib/store/client-hooks";

/**
 * The header's Brands entry (prototype `header` `.dd`, ADR 0097): a link to the brands page that
 * opens a panel of brands on hover or focus. The brands are read the first time it opens.
 */
export function BrandsMenu({ current }: { current: boolean }) {
  const { brands, ensure } = useStoreBrands();
  return (
    <div className="dd" onMouseEnter={ensure} onFocus={ensure}>
      <Link
        href="/brands"
        prefetch={false}
        aria-haspopup="true"
        aria-current={current ? "page" : undefined}
      >
        Brands <Icon name="chev-d" size="sm" />
      </Link>
      <div className="dd-panel">
        <div className="dd-in">
          {brands.state === "ready" &&
            brands.items.map((brand) => (
              <Link key={brand.slug} href={`/brands/${brand.slug}`} prefetch={false}>
                <b>{brand.name}</b>
                <span>
                  {brand.productCount} {brand.productCount === 1 ? "product" : "products"}
                </span>
              </Link>
            ))}
          <Link href="/brands" prefetch={false} className="all">
            All brands <Icon name="arrow-r" size="sm" />
          </Link>
        </div>
      </div>
    </div>
  );
}
