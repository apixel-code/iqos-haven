"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { removeFromList, useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { ProductGrid } from "./product-card";
import { Icon } from "@/components/icons";

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
      <p role="status" className="small muted list-wait">
        Loading your saved items…
      </p>
    );
  if (saved.length === 0)
    return (
      // The prototype's empty wishlist.
      <div className="empty list-empty">
        <span className="ic">
          <Icon name="heart" size="lg" />
        </span>
        <h2 className="h3">Nothing saved yet</h2>
        <p>Tap the heart on any product to keep it here. Saved items stay on this device.</p>
        <Link href="/shop" prefetch={false} className="btn btn-primary">
          Browse products
        </Link>
      </div>
    );
  if (cards.status === "failed")
    return (
      <p role="alert" className="muted list-wait">
        We couldn&apos;t load your saved items just now. They are still saved on this device; please
        try again in a moment.
      </p>
    );
  return (
    <div className="list-page">
      {cards.missing.length > 0 && (
        <div className="notice">
          <p>
            {cards.missing.length} saved {cards.missing.length === 1 ? "item is" : "items are"} no
            longer available.
          </p>
          <button
            type="button"
            className="link"
            onClick={() => cards.missing.forEach((slug) => removeFromList("saved", slug))}
          >
            Remove {cards.missing.length === 1 ? "it" : "them"} from saved items
          </button>
        </div>
      )}
      {saved.length > shown.length && (
        <p className="small muted">Showing your {shown.length} most recently saved items.</p>
      )}
      <ProductGrid products={cards.cards} />
    </div>
  );
}
