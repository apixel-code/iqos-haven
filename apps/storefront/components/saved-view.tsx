"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { removeFromList, useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { ProductGrid } from "./product-card";

const button =
  "inline-flex h-10 items-center rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Saved items (prototype wishlist): products saved on this device, shown with current data. */
export function SavedView() {
  const saved = useDeviceLists().saved;
  // The API takes up to 24 slugs; the newest saved items are shown.
  const shown = saved.slice(0, 24);
  const cards = useProductCards(shown);
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  if (!mounted || cards.status === "loading")
    return (
      <p role="status" className="py-9 text-sm text-ink-2">
        Loading your saved items…
      </p>
    );
  if (saved.length === 0)
    return (
      <div className="flex flex-col items-center gap-3.5 rounded-lg border border-dashed border-line-2 bg-surface px-5 py-14 text-center">
        <h2 className="text-lg font-semibold">Nothing saved yet</h2>
        <p className="max-w-sm text-sm text-ink-2">
          Tap the heart on any product to keep it here. Saved items stay on this device.
        </p>
        <Link href="/shop" prefetch={false} className={button}>
          Browse products
        </Link>
      </div>
    );
  if (cards.status === "failed")
    return (
      <p role="alert" className="py-9 text-sm text-ink-2">
        We couldn&apos;t load your saved items just now. They are still saved on this device; please
        try again in a moment.
      </p>
    );
  return (
    <div className="flex flex-col gap-6 pb-12">
      {cards.missing.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md bg-accent-soft px-4 py-3 text-sm">
          <p>
            {cards.missing.length} saved {cards.missing.length === 1 ? "item is" : "items are"} no
            longer available.
          </p>
          <button
            type="button"
            onClick={() => cards.missing.forEach((slug) => removeFromList("saved", slug))}
            className="w-fit font-medium underline underline-offset-2"
          >
            Remove {cards.missing.length === 1 ? "it" : "them"} from saved items
          </button>
        </div>
      )}
      {saved.length > shown.length && (
        <p className="text-sm text-ink-2">Showing your {shown.length} most recently saved items.</p>
      )}
      <ProductGrid products={cards.cards} />
    </div>
  );
}
