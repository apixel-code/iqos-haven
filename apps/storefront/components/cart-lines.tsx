"use client";

import Link from "next/link";
import type { StoreCartLine } from "@ih/contracts";
import { CART_LIMITS, type CartViewLine } from "@/lib/cart/cart";
import { removeFromCart, restoreCartLine, setCartQuantity } from "@/lib/cart/store";
import { toast } from "@/lib/ui/toast";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";

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
  // The prototype's `cartLines`: picture, name and options, stepper and price, Remove.
  return (
    <ul className="lines">
      {lines.map((line) => {
        const blocked = line.status === "sold_out" || line.status === "unavailable";
        const image = images.get(line.variantId);
        return (
          <li key={line.variantId} className={blocked ? "line off" : "line"}>
            <span className="th">
              {image && (
                // Signed link to a sanitized derivative; the Next image optimizer is not used.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image.urls.thumb} alt="" width={76} height={92} />
              )}
            </span>
            <div className="t">
              {line.status === "unavailable" ? (
                <span className="nm">{line.name}</span>
              ) : (
                <Link href={`/p/${line.productSlug}`} prefetch={false} onClick={onNavigate}>
                  {line.name}
                </Link>
              )}
              <span className="v">{[line.brand, line.options].filter(Boolean).join(" · ")}</span>
              {blocked && <p className="line-err">{STATUS_TEXT[line.status]}</p>}
              {!blocked && line.previousUnitPriceFils !== null && (
                <p className="line-note">
                  Price changed from <Money fils={line.previousUnitPriceFils} /> to{" "}
                  <Money fils={line.unitPriceFils} /> since you added it.
                </p>
              )}
              <div className="r">
                <div className="stepper sm" role="group" aria-label={`Quantity for ${line.name}`}>
                  <button
                    type="button"
                    aria-label="Decrease"
                    disabled={blocked || line.quantity <= 1}
                    onClick={() => setCartQuantity(line.variantId, line.quantity - 1)}
                  >
                    <Icon name="minus" size="sm" />
                  </button>
                  <output aria-live="polite">{line.quantity}</output>
                  <button
                    type="button"
                    aria-label="Increase"
                    disabled={blocked || line.quantity >= CART_LIMITS.maxQuantity}
                    onClick={() => setCartQuantity(line.variantId, line.quantity + 1)}
                  >
                    <Icon name="plus" size="sm" />
                  </button>
                </div>
                <div className={blocked ? "price struck" : "price"}>
                  <span className="now">
                    <Money fils={line.lineTotalFils} />
                  </span>
                </div>
              </div>
              <div>
                <button
                  type="button"
                  className="rm"
                  aria-label={`Remove ${line.name}`}
                  onClick={() => {
                    const removed = removeFromCart(line.variantId);
                    // The prototype's "Removed from cart" with Undo (parity G-S10).
                    if (removed)
                      toast({
                        title: "Removed from cart",
                        sub: line.name,
                        action: {
                          label: "Undo",
                          run: () => restoreCartLine(removed.line, removed.index),
                        },
                      });
                  }}
                >
                  <Icon name="trash" size="sm" /> Remove
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
