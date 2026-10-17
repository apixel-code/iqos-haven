"use client";

import Link from "next/link";
import type { StoreCartLine } from "@ih/contracts";
import { CART_LIMITS, type CartViewLine } from "@/lib/cart/cart";
import { removeFromCart, setCartQuantity } from "@/lib/cart/store";
import { displayAed } from "@/lib/store/listing";

const STATUS_TEXT: Partial<Record<CartViewLine["status"], string>> = {
  sold_out: "Sold out. Remove it to continue, or check back later.",
  unavailable: "No longer available. Remove it to continue.",
};

/**
 * The cart's lines with quantity and remove controls, shared by the cart page and the cart
 * sheet (parity G-S1). Prices are the API's current ones; a sold-out or withdrawn line stays
 * visible, flagged and struck through, and is never swapped for another variant.
 */
export function CartLines({
  lines,
  images,
  onNavigate,
}: {
  lines: readonly CartViewLine[];
  images: ReadonlyMap<string, StoreCartLine["image"]>;
  /** Called when a product link is followed (the sheet closes itself). */
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {lines.map((line) => {
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
              <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{line.brand}</p>
              {line.status === "unavailable" ? (
                <span className="font-medium">{line.name}</span>
              ) : (
                <Link
                  href={`/p/${line.productSlug}`}
                  prefetch={false}
                  onClick={onNavigate}
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
  );
}
