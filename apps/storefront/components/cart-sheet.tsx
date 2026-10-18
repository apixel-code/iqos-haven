"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { useFreshCart } from "@/lib/cart/fresh";
import { cartCount } from "@/lib/cart/cart";
import { closeCartSheet, useCartSheet } from "@/lib/cart/sheet";
import { useCart } from "@/lib/cart/store";
import { SITE } from "@/lib/site";
import { whatsappHref, WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { CartLines } from "./cart-lines";
import { Sheet } from "./sheet";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

/**
 * Cart sheet after adding (parity G-S1, ADR 0082) as the prototype's `cartSheet` (V-S6): a side
 * panel on a phone, a pop-over under the header's cart button from 720 px. It shows the lines
 * with the API's current prices, the subtotal and the way on. Delivery, any discount and the total are confirmed on the cart page, which holds the accepted
 * server quote checkout needs; the sheet never shows a payable total.
 */
export function CartSheet({ whatsappNumber }: { whatsappNumber: string | null }) {
  const { open, revision } = useCartSheet();
  const [place, setPlace] = useState<{ pop: boolean; style?: CSSProperties }>({ pop: false });
  useEffect(() => {
    if (!open) return;
    // Measured in the next frame, before the sheet slides in (it waits two frames).
    const frame = requestAnimationFrame(() => {
      // From 720 px the prototype's pop-over hangs under the header's cart button.
      const wide = window.matchMedia("(min-width: 720px)").matches;
      const anchor = document.querySelector<HTMLElement>("[data-cart-anchor]");
      const box = wide ? anchor?.getBoundingClientRect() : undefined;
      setPlace(
        !wide
          ? { pop: false }
          : box && box.width > 0
            ? {
                pop: true,
                style: {
                  top: Math.max(12, box.bottom + 10),
                  right: Math.max(12, window.innerWidth - (box.left + box.width / 2) - 28),
                },
              }
            : { pop: true },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [open, revision]);
  return (
    <Sheet
      open={open}
      onClose={closeCartSheet}
      title="Your cart"
      side={place.pop ? "pop" : "right"}
      clearBackdrop={place.pop}
      {...(place.style ? { style: place.style } : {})}
      heading={<SheetTitle />}
      bare
    >
      {open && <SheetBody whatsappNumber={whatsappNumber} />}
    </Sheet>
  );
}

/** "Your cart (2)": the count from this device, without asking the API again. */
function SheetTitle() {
  const units = cartCount(useCart());
  return (
    <>
      Your cart{" "}
      {units > 0 && (
        <span className="muted" style={{ fontWeight: 400 }}>
          ({units})
        </span>
      )}
    </>
  );
}

function SheetBody({ whatsappNumber }: { whatsappNumber: string | null }) {
  const { cart, images, view, failed, mounted } = useFreshCart();
  const buyable = view.lines.filter(
    (line) => line.status === "ok" || line.status === "unconfirmed",
  );
  const whatsapp = buyable.length
    ? whatsappHref(whatsappNumber, WHATSAPP_MESSAGES.cart(SITE.name, buyable))
    : null;
  return (
    <>
      <div className="sh-body">
        {!mounted ? (
          <p role="status" className="small muted">
            Loading your cart…
          </p>
        ) : cart.lines.length === 0 ? (
          <div className="empty cart-empty">
            <span className="ic">
              <Icon name="bag" size="lg" />
            </span>
            <h3 className="h3">Your cart is empty</h3>
            <p>Browse disposables and kits, or ask us on WhatsApp for a recommendation.</p>
            <button type="button" className="btn btn-primary" onClick={closeCartSheet}>
              Continue shopping
            </button>
          </div>
        ) : (
          <>
            <p role="status" aria-live="polite" className="small muted cart-status">
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
        <div className="sh-foot">
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
          <p className="small muted">
            Delivery and any discount are added in your cart. Cash on delivery.
          </p>
          <Link
            href="/cart"
            prefetch={false}
            onClick={closeCartSheet}
            className="btn btn-primary btn-lg btn-block"
          >
            View cart and checkout
          </Link>
          <div className="sh-row">
            <button type="button" className="btn btn-outline btn-sm" onClick={closeCartSheet}>
              Continue shopping
            </button>
            {whatsapp && (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm btn-wa-line"
              >
                <Icon name="wa" size="sm" /> Order on WhatsApp
              </a>
            )}
          </div>
        </div>
      )}
    </>
  );
}
