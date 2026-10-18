"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";
import { CountBadge } from "@/components/count-badge";
import { Icon } from "@/components/icons";
import { cartCount } from "@/lib/cart/cart";
import { openCartSheet } from "@/lib/cart/sheet";
import { useCart } from "@/lib/cart/store";
import { LIST_LIMITS } from "@/lib/device/lists";
import { removeFromList, useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { SITE } from "@/lib/site";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";

/**
 * The prototype's fixed overlays (`overlays()`, ADR 0097): the phone bottom navigation (hidden
 * on checkout and product pages) and the WhatsApp button (hidden on cart and checkout, and on a
 * phone's product page, where the sticky add-to-cart bar sits).
 */
export function StoreOverlays({ whatsappNumber }: { whatsappNumber: string | null }) {
  const pathname = usePathname();
  const cart = cartCount(useCart());
  const lists = useDeviceLists();
  const saved = lists.saved.length;
  const compare = lists.compare;
  const at = (path: string) => pathname === path || pathname.startsWith(path + "/");
  const product = at("/p");
  const showNav = !at("/checkout") && !product;
  const wa = whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.general(SITE.name));
  const showWa = wa && !at("/checkout") && !at("/cart");
  // The prototype's compare tray (parity G-S11): not where it would be in the way or repeat
  // itself (compare, checkout, product and confirmation pages).
  const showTray =
    compare.length > 0 &&
    !at("/compare") &&
    !at("/checkout") &&
    !product &&
    !at("/order-confirmation");
  const current = (on: boolean) => (on ? ("page" as const) : undefined);
  const openSheet = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    openCartSheet();
  };
  return (
    <div id="overlay">
      {showNav && (
        <nav className="bnav" aria-label="Quick navigation">
          <Link href="/" prefetch={false} aria-current={current(pathname === "/")}>
            <Icon name="home" />
            Home
          </Link>
          <Link
            href="/shop"
            prefetch={false}
            aria-current={current(
              at("/shop") || at("/brands") || at("/disposable-vapes") || at("/vape-kits"),
            )}
          >
            <Icon name="grid" />
            Shop
          </Link>
          <Link href="/offers" prefetch={false} aria-current={current(at("/offers"))}>
            <Icon name="tag" />
            Offers
          </Link>
          <Link href="/wishlist" prefetch={false} aria-current={current(at("/wishlist"))}>
            <Icon name="heart" />
            Saved
            {saved > 0 && <span className="count">{saved}</span>}
          </Link>
          <Link
            href="/cart"
            prefetch={false}
            onClick={openSheet}
            aria-current={current(at("/cart"))}
          >
            <Icon name="bag" />
            Cart
            <CountBadge value={cart} />
          </Link>
        </nav>
      )}
      {showTray && <CompareTray slugs={compare} />}
      {showWa && (
        <a
          className={`wafab${product ? " wafab-pdp" : ""}${showTray ? " up" : ""}`}
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Chat on WhatsApp"
        >
          <Icon name="wa" size="lg" />
        </a>
      )}
    </div>
  );
}

/** "N of 3 kits", their pictures, the way to the comparison and a way to clear it. */
function CompareTray({ slugs }: { slugs: readonly string[] }) {
  const cards = useProductCards(slugs);
  const shown = cards.status === "ready" ? cards.cards : [];
  return (
    <div className="ctray" role="region" aria-label="Compare tray">
      <span className="thumbs" aria-hidden="true">
        {shown.map((card) => (
          <i key={card.slug}>
            {card.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.image.urls.thumb} alt="" width={36} height={36} />
            )}
          </i>
        ))}
      </span>
      <span className="t">
        {slugs.length} of {LIST_LIMITS.compare} kits
      </span>
      <Link href="/compare" prefetch={false} className="btn">
        Compare
      </Link>
      <button
        type="button"
        className="ibtn"
        aria-label="Clear compare"
        onClick={() => {
          for (const slug of slugs) removeFromList("compare", slug);
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
