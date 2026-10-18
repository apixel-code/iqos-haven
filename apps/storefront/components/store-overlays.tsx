"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";
import { Icon } from "@/components/icons";
import { cartCount } from "@/lib/cart/cart";
import { openCartSheet } from "@/lib/cart/sheet";
import { useCart } from "@/lib/cart/store";
import { useDeviceLists } from "@/lib/device/store";
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
  const saved = useDeviceLists().saved.length;
  const at = (path: string) => pathname === path || pathname.startsWith(path + "/");
  const product = at("/p");
  const showNav = !at("/checkout") && !product;
  const wa = whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.general(SITE.name));
  const showWa = wa && !at("/checkout") && !at("/cart");
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
            {cart > 0 && <span className="count">{cart}</span>}
          </Link>
        </nav>
      )}
      {showWa && (
        <a
          className={product ? "wafab wafab-pdp" : "wafab"}
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
