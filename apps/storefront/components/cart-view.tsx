"use client";

import Link from "next/link";
import { useState } from "react";
import { useFreshCart } from "@/lib/cart/fresh";
import { rememberChoice, rememberedChoice } from "@/lib/checkout/memory";
import { SITE } from "@/lib/site";
import { displayAed } from "@/lib/store/listing";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { CartLines } from "./cart-lines";
import { CartQuote } from "./cart-quote";
import { RecentlyViewed } from "./recently-viewed";

/**
 * The device cart (roadmap step 62, ADR 0031). Lines come from this device; their current
 * price and availability come from the API (which checks the age ticket) each time the set of
 * variants changes. A line that is sold out or no longer offered stays visible and flagged; it
 * is never replaced by another variant and never counted in the subtotal.
 */
export function CartView({
  whatsappNumber,
  checkoutOpen,
}: {
  whatsappNumber: string | null;
  /** Whether the shop is taking orders; the API decides again when one is placed. */
  checkoutOpen: boolean;
}) {
  const { cart, images, view, failed, mounted, recheck } = useFreshCart();
  // Whether the shopper holds an accepted, current server total (step 71).
  const [quoteReady, setQuoteReady] = useState(false);

  if (!mounted)
    return (
      <p role="status" className="py-9 text-sm text-ink-2">
        Loading your cart…
      </p>
    );
  if (cart.lines.length === 0)
    return (
      <div className="flex flex-col items-center gap-3.5 px-2 py-9 text-center">
        <h2 className="text-lg font-semibold">Your cart is empty</h2>
        <p className="max-w-sm text-sm text-ink-2">Browse disposables and kits to get started.</p>
        <Link
          href="/shop"
          prefetch={false}
          className="inline-flex h-10 items-center rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Start shopping
        </Link>
        <div className="w-full text-left">
          <RecentlyViewed />
        </div>
      </div>
    );

  const units = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  const quoteLines = view.lines
    .filter((line) => line.status === "ok" || line.status === "unconfirmed")
    .map(({ variantId, quantity, name }) => ({ variantId, quantity, name }));
  return (
    <>
      <p className="pb-4 text-sm text-ink-2">
        {units} {units === 1 ? "item" : "items"}
      </p>
      <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <p role="status" aria-live="polite" className="min-h-5 text-sm text-ink-2">
            {view.blockedCount > 0
              ? `${view.blockedCount} ${view.blockedCount === 1 ? "item needs" : "items need"} your attention.`
              : failed && !view.confirmed
                ? "We couldn't check prices and availability just now. They will be confirmed at checkout."
                : !view.confirmed
                  ? "Checking prices and availability…"
                  : ""}
          </p>
          <CartLines lines={view.lines} images={images} />
          {/* Sends nothing: it opens WhatsApp with the cart written out for the shopper to send. */}
          {(() => {
            const buyable = view.lines.filter(
              (line) => line.status === "ok" || line.status === "unconfirmed",
            );
            const href = buyable.length
              ? whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.cart(SITE.name, buyable))
              : null;
            return href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-fit flex-col rounded-md border border-line bg-surface px-4 py-3 text-sm hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <b className="font-semibold">Prefer to order on WhatsApp?</b>
                <span className="text-ink-2">Send this cart to our team</span>
              </a>
            ) : null;
          })()}
        </div>
        <aside
          aria-label="Order summary"
          className="flex h-fit flex-col gap-3 rounded-lg border border-line bg-surface p-5 lg:sticky lg:top-6"
        >
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt>
                Subtotal ({view.itemCount} {view.itemCount === 1 ? "item" : "items"})
              </dt>
              <dd className="font-semibold">{displayAed(view.subtotalFils)}</dd>
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
          <p className="text-xs text-ink-3">
            Cash on delivery: no account needed, pay when your order arrives.
          </p>
          {view.blockedCount > 0 && (
            <p className="text-sm font-medium text-error">
              Remove the unavailable {view.blockedCount === 1 ? "item" : "items"} before checking
              out.
            </p>
          )}
          {checkoutOpen && quoteReady && view.blockedCount === 0 ? (
            <Link
              href="/checkout"
              prefetch={false}
              className="flex h-12 items-center justify-center rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Checkout · Cash on delivery
            </Link>
          ) : (
            <>
              <button
                type="button"
                disabled
                className="h-12 cursor-not-allowed rounded-pill bg-primary px-6 text-base font-medium text-on-primary opacity-50"
              >
                Checkout · Cash on delivery
              </button>
              <p className="text-center text-xs text-ink-3">
                {!checkoutOpen
                  ? quoteReady
                    ? "Your total is confirmed. Checkout is not open yet."
                    : "Checkout is not open yet."
                  : "Choose your delivery area to continue."}
              </p>
            </>
          )}
          <Link
            href="/shop"
            prefetch={false}
            className="text-center text-sm underline underline-offset-2"
          >
            Continue shopping
          </Link>
        </aside>
      </div>
    </>
  );
}
