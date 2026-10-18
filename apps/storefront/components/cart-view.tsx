"use client";

import Link from "next/link";
import type { StoreProductCard } from "@ih/contracts";
import { useState } from "react";
import { useFreshCart } from "@/lib/cart/fresh";
import { rememberChoice, rememberedChoice } from "@/lib/checkout/memory";
import { SITE } from "@/lib/site";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { CartLines } from "./cart-lines";
import { CartQuote } from "./cart-quote";
import { PageHead } from "./listing";
import { ProductCard } from "./product-card";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";
import { useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";

/**
 * The device cart (roadmap step 62, ADR 0031). Lines come from this device; their current
 * price and availability come from the API (which checks the age ticket) each time the set of
 * variants changes. A line that is sold out or no longer offered stays visible and flagged; it
 * is never replaced by another variant and never counted in the subtotal.
 */
export function CartView({
  whatsappNumber,
  checkoutOpen,
  bestSellers,
}: {
  whatsappNumber: string | null;
  /** The Owner's best sellers, shown in an empty cart with no browsing history (G-S14). */
  bestSellers: readonly StoreProductCard[];
  /** Whether the shop is taking orders; the API decides again when one is placed. */
  checkoutOpen: boolean;
}) {
  const { cart, images, view, failed, mounted, recheck } = useFreshCart();
  // Whether the shopper holds an accepted, current server total (step 71).
  const [quoteReady, setQuoteReady] = useState(false);

  if (!mounted)
    return (
      <>
        <PageHead title="Your cart" />
        <p role="status" className="small muted cart-wait">
          Loading your cart…
        </p>
      </>
    );
  if (cart.lines.length === 0)
    return (
      <>
        <PageHead title="Your cart" />
        <EmptyCart bestSellers={bestSellers} />
      </>
    );
  const units = cart.lines.reduce((sum, line) => sum + line.quantity, 0);

  const quoteLines = view.lines
    .filter((line) => line.status === "ok" || line.status === "unconfirmed")
    .map(({ variantId, quantity, name }) => ({ variantId, quantity, name }));
  const buyable = view.lines.filter(
    (line) => line.status === "ok" || line.status === "unconfirmed",
  );
  // Sends nothing: it opens WhatsApp with the cart written out for the shopper to send.
  const waHref = buyable.length
    ? whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.cart(SITE.name, buyable))
    : null;
  return (
    <>
      <PageHead title="Your cart" lead={`${units} ${units === 1 ? "item" : "items"}`} />
      <div className="cart-page">
        <div>
          <p role="status" aria-live="polite" className="small muted cart-status">
            {view.blockedCount > 0
              ? `${view.blockedCount} ${view.blockedCount === 1 ? "item needs" : "items need"} your attention.`
              : failed && !view.confirmed
                ? "We couldn't check prices and availability just now. They will be confirmed at checkout."
                : !view.confirmed
                  ? "Checking prices and availability…"
                  : ""}
          </p>
          <CartLines lines={view.lines} images={images} />
          {waHref && (
            <a href={waHref} target="_blank" rel="noopener noreferrer" className="wa-card">
              <span className="wa-ic" aria-hidden="true">
                <Icon name="wa" />
              </span>
              <span className="t">
                <b>Prefer to order on WhatsApp?</b>
                <span>Send this cart to our team</span>
              </span>
              <Icon name="chev-r" />
            </a>
          )}
        </div>
        <aside aria-label="Order summary" className="panel sticky">
          <dl className="totals">
            <div>
              <dt>
                Subtotal ({view.itemCount} {view.itemCount === 1 ? "item" : "items"})
              </dt>
              <dd>
                <Money fils={view.subtotalFils} />
              </dd>
            </div>
          </dl>
          <CartQuote
            lines={quoteLines}
            blocked={view.blockedCount}
            onUnavailable={recheck}
            onReady={setQuoteReady}
            initial={rememberedChoice()}
            onChoice={rememberChoice}
          />
          {view.blockedCount > 0 && (
            <p className="errmsg">
              <Icon name="info" size="sm" />
              Remove the unavailable {view.blockedCount === 1 ? "item" : "items"} before checking
              out.
            </p>
          )}
          {checkoutOpen && quoteReady && view.blockedCount === 0 ? (
            <Link href="/checkout" prefetch={false} className="btn btn-primary btn-lg btn-block">
              Checkout · Cash on delivery
            </Link>
          ) : (
            <>
              <button type="button" disabled className="btn btn-primary btn-lg btn-block">
                Checkout · Cash on delivery
              </button>
              <p className="small muted center">
                {!checkoutOpen
                  ? quoteReady
                    ? "Your total is confirmed. Checkout is not open yet."
                    : "Checkout is not open yet."
                  : "Choose your delivery area to continue."}
              </p>
            </>
          )}
          <p className="small muted center">No account needed. Pay when your order arrives.</p>
          <Link href="/shop" prefetch={false} className="link small center">
            Continue shopping
          </Link>
        </aside>
      </div>
    </>
  );
}

/**
 * The prototype's `emptyCart`: a way back to the shop, then what this device viewed recently or,
 * with no history, the Owner's best sellers (parity G-S14). Sold-out products are left out.
 */
function EmptyCart({ bestSellers }: { bestSellers: readonly StoreProductCard[] }) {
  const recent = useDeviceLists().recent.slice(0, 4);
  const viewed = useProductCards(recent);
  const recentCards =
    viewed.status === "ready" ? viewed.cards.filter((card) => !card.soldOut).slice(0, 4) : [];
  const picks = recentCards.length
    ? recentCards
    : bestSellers.filter((card) => !card.soldOut).slice(0, 4);
  // While the recently viewed cards load, nothing is shown in their place.
  const waiting = recent.length > 0 && viewed.status !== "ready" && viewed.status !== "failed";
  return (
    <>
      <div className="empty cart-empty">
        <span className="ic">
          <Icon name="bag" size="lg" />
        </span>
        <h2 className="h3">Your cart is empty</h2>
        <p>Browse disposables and kits, or ask us on WhatsApp for a recommendation.</p>
        <Link href="/shop" prefetch={false} className="btn btn-primary">
          Start shopping
        </Link>
      </div>
      {!waiting && picks.length > 0 && (
        <section aria-labelledby="cart-picks-h" className="cart-picks">
          <h3 className="eyebrow" id="cart-picks-h">
            {recentCards.length ? "Recently viewed" : "Best sellers"}
          </h3>
          <ul className="pgrid">
            {picks.map((product) => (
              <li key={product.slug}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
