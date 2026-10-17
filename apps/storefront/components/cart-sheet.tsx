"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useFreshCart } from "@/lib/cart/fresh";
import { closeCartSheet, useCartSheetOpen } from "@/lib/cart/sheet";
import { SITE } from "@/lib/site";
import { displayAed } from "@/lib/store/listing";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { CartLines } from "./cart-lines";

/**
 * Cart sheet after adding (parity G-S1, ADR 0082): a bottom sheet on a phone, a side panel on a
 * wide screen. It shows the lines with the API's current prices, the subtotal and the way on.
 * Delivery, any discount and the total are confirmed on the cart page, which holds the accepted
 * server quote checkout needs; the sheet never shows a payable total.
 */
export function CartSheet({ whatsappNumber }: { whatsappNumber: string | null }) {
  const open = useCartSheetOpen();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="cart-sheet-title"
      onClose={closeCartSheet}
      // A click on the backdrop (outside the panel) closes the sheet.
      onClick={(event) => event.target === event.currentTarget && closeCartSheet()}
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-hidden rounded-t-lg bg-surface p-0 text-ink shadow-3 backdrop:bg-ink/40 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-dvh sm:w-[26rem] sm:rounded-none"
    >
      {open && <SheetBody whatsappNumber={whatsappNumber} />}
    </dialog>
  );
}

function SheetBody({ whatsappNumber }: { whatsappNumber: string | null }) {
  const { cart, images, view, failed, mounted } = useFreshCart();
  const units = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  const buyable = view.lines.filter(
    (line) => line.status === "ok" || line.status === "unconfirmed",
  );
  const whatsapp = buyable.length
    ? whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.cart(SITE.name, buyable))
    : null;
  return (
    <div className="flex max-h-[85dvh] flex-col sm:h-dvh sm:max-h-dvh">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="cart-sheet-title" className="text-lg font-semibold">
          Your cart {units > 0 && <span className="font-normal text-ink-2">({units})</span>}
        </h2>
        <button
          type="button"
          aria-label="Close cart"
          onClick={closeCartSheet}
          className="size-10 rounded-pill text-xl hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          ×
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-5">
        {!mounted ? (
          <p role="status" className="py-6 text-sm text-ink-2">
            Loading your cart…
          </p>
        ) : cart.lines.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-9 text-center">
            <p className="font-semibold">Your cart is empty</p>
            <button
              type="button"
              onClick={closeCartSheet}
              className="text-sm underline underline-offset-2"
            >
              Continue shopping
            </button>
          </div>
        ) : (
          <>
            <p role="status" aria-live="polite" className="min-h-5 pt-3 text-sm text-ink-2">
              {view.blockedCount > 0
                ? `${view.blockedCount} ${view.blockedCount === 1 ? "item needs" : "items need"} your attention.`
                : failed && !view.confirmed
                  ? "We couldn't check prices just now. They will be confirmed in your cart."
                  : !view.confirmed
                    ? "Checking prices and availability…"
                    : ""}
            </p>
            <CartLines lines={view.lines} images={images} onNavigate={closeCartSheet} />
          </>
        )}
      </div>
      {mounted && cart.lines.length > 0 && (
        <footer className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <dl className="flex justify-between gap-4 text-sm">
            <dt>
              Subtotal ({view.itemCount} {view.itemCount === 1 ? "item" : "items"})
            </dt>
            <dd className="font-semibold">{displayAed(view.subtotalFils)}</dd>
          </dl>
          <p className="text-xs text-ink-3">
            Delivery and any discount are added in your cart. Cash on delivery.
          </p>
          <Link
            href="/cart"
            prefetch={false}
            onClick={closeCartSheet}
            className="flex h-12 items-center justify-center rounded-pill bg-primary px-6 text-base font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            View cart and checkout
          </Link>
          <div className="grid gap-2 min-[400px]:grid-flow-col min-[400px]:auto-cols-fr">
            <button
              type="button"
              onClick={closeCartSheet}
              className="flex h-10 items-center justify-center rounded-pill border-[1.5px] border-line px-4 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Continue shopping
            </button>
            {whatsapp && (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-10 items-center justify-center rounded-pill border-[1.5px] border-line px-4 text-sm font-medium hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Order on WhatsApp
              </a>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
