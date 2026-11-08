"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { BrandsMenu } from "@/components/brands-menu";
import { CountBadge } from "@/components/count-badge";
import { Icon } from "@/components/icons";
import { MenuSheet } from "@/components/menu-sheet";
import { SearchBox } from "@/components/search-box";
import { SearchSheet } from "@/components/search-sheet";
import { cartCount } from "@/lib/cart/cart";
import { openCartSheet } from "@/lib/cart/sheet";
import { useCart } from "@/lib/cart/store";
import { useDeviceLists } from "@/lib/device/store";
import { SITE } from "@/lib/site";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Opens the cart sheet in place, like the prototype; a modified click still opens /cart. */
function openSheet(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
    return;
  event.preventDefault();
  openCartSheet();
}

/**
 * Store header (prototype `header`, ADR 0097): menu (phones), wordmark, sections with the Brands
 * panel, the search bar (wide screens) or search button, WhatsApp, saved items and the cart.
 */
export function SiteHeader({
  whatsappNumber,
  belowPromo,
}: {
  whatsappNumber: string | null;
  /** The promotional bar is shown above, so the header sticks under it. */
  belowPromo: boolean;
}) {
  const pathname = usePathname();
  const cart = cartCount(useCart());
  const saved = useDeviceLists().saved.length;
  const wa = whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.general(SITE.name));
  const at = (path: string) => pathname === path || pathname.startsWith(path + "/");
  const current = (on: boolean) => (on ? ("page" as const) : undefined);
  const inCheckout = at("/cart") || at("/checkout");
  return (
    <header className={belowPromo ? "hdr" : "hdr hdr-top"}>
      <div className="wrap hdr-in">
        <MenuSheet whatsappNumber={whatsappNumber} />
        <Link className="logo" href="/" prefetch={false} aria-label={`${SITE.name} home`}>
          <BrandLogo alt="" />
        </Link>
        <nav className="mainnav" aria-label="Main">
          {/* The logo leads home; "Shop" (all products) takes the old Home place (Marina 2026-11-08). */}
          <Link href="/shop" prefetch={false} aria-current={current(at("/shop"))}>
            Shop
          </Link>
          <Link href="/devices" prefetch={false} aria-current={current(at("/devices"))}>
            IQOS Devices
          </Link>
          <Link href="/sticks" prefetch={false} aria-current={current(at("/sticks"))}>
            TEREA Sticks
          </Link>
          <BrandsMenu current={at("/brands")} />
          <Link href="/offers" prefetch={false} aria-current={current(at("/offers"))}>
            <i className="dot" aria-hidden="true" />
            Offers
          </Link>
        </nav>
        <SearchBox />
        <div className="hdr-actions">
          <SearchSheet />
          {wa && (
            <a
              className="ibtn only-md"
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Chat on WhatsApp"
              style={{ color: "var(--wa)" }}
            >
              <Icon name="wa" />
            </a>
          )}
          <Link
            className="ibtn only-md"
            href="/wishlist"
            prefetch={false}
            aria-label={`Saved items, ${saved}`}
          >
            <Icon name="heart" />
            {saved > 0 && <span className="count">{saved}</span>}
          </Link>
          <Link
            className="ibtn"
            data-cart-anchor
            href="/cart"
            prefetch={false}
            onClick={inCheckout ? undefined : openSheet}
            aria-label={`Cart, ${plural(cart, "item")}`}
          >
            <Icon name="bag" />
            <CountBadge value={cart} data />
          </Link>
        </div>
      </div>
    </header>
  );
}
