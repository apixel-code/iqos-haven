"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { storeCartLinesResponseSchema, type StoreCartLine } from "@ih/contracts";
import { CART_LIMITS, cartView, type CartViewLine } from "@/lib/cart/cart";
import { removeFromCart, setCartQuantity, useCart } from "@/lib/cart/store";
import { SITE } from "@/lib/site";
import { displayAed } from "@/lib/store/listing";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { RecentlyViewed } from "./recently-viewed";

/** Outcome of the latest refresh, tagged with the variant set it was for. */
type Outcome = { key: string; ok: boolean } | null;
type Known = ReadonlyMap<string, StoreCartLine | null>;

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
export function CartView({ whatsappNumber }: { whatsappNumber: string | null }) {
  const cart = useCart();
  // Only the set of variants matters for the refresh, not their quantities.
  const key = useMemo(
    () =>
      cart.lines
        .map((line) => line.variantId)
        .sort()
        .join(","),
    [cart.lines],
  );
  // Latest server answer per variant. Kept across refreshes: what the server said about a
  // variant applies for as long as it is in the cart.
  const [known, setKnown] = useState<Known>(new Map());
  const [outcome, setOutcome] = useState<Outcome>(null);
  // False while the server-rendered frame is shown; the device cart is read after hydration.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const ids = key.split(",");
    fetch(`/api/v1/store/cart/lines?${ids.map((id) => `variant=${id}`).join("&")}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("refresh"))))
      .then((body: unknown) => {
        const parsed = storeCartLinesResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("contract");
        const returned = new Map(parsed.data.lines.map((line) => [line.variantId, line]));
        // Every requested ID now has an answer: its line, or null for "not offered".
        setKnown((previous) => {
          const next = new Map(previous);
          for (const id of ids) next.set(id, returned.get(id) ?? null);
          return next;
        });
        setOutcome({ key, ok: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setOutcome({ key, ok: false });
      });
    return () => controller.abort();
  }, [key]);

  const view = cartView(cart, known);
  const failed = outcome?.key === key && !outcome.ok;
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
            <div className="flex justify-between gap-4 text-ink-2">
              <dt>Delivery</dt>
              <dd>Calculated at checkout</dd>
            </div>
          </dl>
          <p className="text-xs text-ink-3">
            Prices and availability are confirmed when you check out. Cash on delivery: no account
            needed, pay when your order arrives.
          </p>
          {view.blockedCount > 0 && (
            <p className="text-sm font-medium text-error">
              Remove the unavailable {view.blockedCount === 1 ? "item" : "items"} before checking
              out.
            </p>
          )}
          {/* Checkout arrives with the order milestone; the button is honest about that. */}
          <button
            type="button"
            disabled
            className="h-12 cursor-not-allowed rounded-pill bg-primary px-6 text-base font-medium text-on-primary opacity-50"
          >
            Checkout · Cash on delivery
          </button>
          <p className="text-center text-xs text-ink-3">Checkout is not open yet.</p>
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
