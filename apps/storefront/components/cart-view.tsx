"use client";

import Link from "next/link";
import { useState } from "react";
import { CART_LIMITS, type CartViewLine } from "@/lib/cart/cart";
import { useFreshCart } from "@/lib/cart/fresh";
import { removeFromCart, setCartQuantity } from "@/lib/cart/store";
import { rememberChoice, rememberedChoice } from "@/lib/checkout/memory";
import { SITE } from "@/lib/site";
import { displayAed } from "@/lib/store/listing";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { CartQuote } from "./cart-quote";
import { RecentlyViewed } from "./recently-viewed";

const STATUS_TEXT: Partial<Record<CartViewLine["status"], string>> = {
  sold_out: "Sold out. Remove it to continue, or check back later.",
  unavailable: "No longer available. Remove it to continue.",
};

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
  const { cart, known, view, failed, mounted, recheck } = useFreshCart();
  // Whether the shopper holds an accepted, current server total (step 71).
  const [quoteReady, setQuoteReady] = useState(false);
  const images = new Map(
    [...known].flatMap(([id, line]) => (line ? [[id, line.image] as const] : [])),
  );

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
          <ul className="flex flex-col divide-y divide-line">
            {view.lines.map((line) => {
              const blocked = line.status === "sold_out" || line.status === "unavailable";
              const image = images.get(line.variantId);
              return (
                <li key={line.variantId} className="flex gap-4 py-4">
                  <div className="size-20 shrink-0 overflow-hidden rounded-sm bg-surface-2">
                    {image && (
                      // Signed link to a sanitized derivative; the Next image optimizer is not used.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={image.urls.thumb}
                        alt=""
                        width={80}
                        height={80}
                        className={`size-full object-cover ${blocked ? "opacity-45 grayscale" : ""}`}
                      />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">
                      {line.brand}
                    </p>
                    {line.status === "unavailable" ? (
                      <span className="font-medium">{line.name}</span>
                    ) : (
                      <Link
                        href={`/p/${line.productSlug}`}
                        prefetch={false}
                        className="font-medium hover:underline"
                      >
                        {line.name}
                      </Link>
                    )}
                    {line.options && <p className="text-sm text-ink-2">{line.options}</p>}
                    {blocked && (
                      <p className="text-sm font-medium text-error">{STATUS_TEXT[line.status]}</p>
                    )}
                    {!blocked && line.previousUnitPriceFils !== null && (
                      <p className="text-sm text-ink-2">
                        Price changed from {displayAed(line.previousUnitPriceFils)} to{" "}
                        {displayAed(line.unitPriceFils)} since you added it.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <div
                        role="group"
                        aria-label={`Quantity for ${line.name}`}
                        className="inline-flex h-10 items-center rounded-pill border-[1.5px] border-line bg-surface"
                      >
                        <button
                          type="button"
                          aria-label="Decrease"
                          disabled={blocked || line.quantity <= 1}
                          onClick={() => setCartQuantity(line.variantId, line.quantity - 1)}
                          className="size-10 rounded-pill disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          −
                        </button>
                        <output aria-live="polite" className="w-7 text-center text-sm font-medium">
                          {line.quantity}
                        </output>
                        <button
                          type="button"
                          aria-label="Increase"
                          disabled={blocked || line.quantity >= CART_LIMITS.maxQuantity}
                          onClick={() => setCartQuantity(line.variantId, line.quantity + 1)}
                          className="size-10 rounded-pill disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => removeFromCart(line.variantId)}
                        className="text-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        Remove
                      </button>
                      <span
                        className={`ml-auto text-base font-semibold ${blocked ? "text-ink-3 line-through" : ""}`}
                      >
                        {displayAed(line.lineTotalFils)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
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
