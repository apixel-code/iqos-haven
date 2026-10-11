"use client";

import Link from "next/link";
import { cartCount } from "@/lib/cart/cart";
import { useCart } from "@/lib/cart/store";

/** Header link to the cart with the number of items on this device. */
export function CartLink() {
  const count = cartCount(useCart());
  return (
    <Link
      href="/cart"
      prefetch={false}
      aria-label={count === 0 ? "Cart, empty" : `Cart, ${count} ${count === 1 ? "item" : "items"}`}
      className="inline-flex h-10 items-center gap-2 rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      Cart
      {count > 0 && (
        <span
          aria-hidden="true"
          className="inline-flex min-w-5 justify-center rounded-pill bg-accent px-1.5 text-xs font-semibold text-ink"
        >
          {count}
        </span>
      )}
    </Link>
  );
}
