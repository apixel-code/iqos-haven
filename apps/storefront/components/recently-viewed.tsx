"use client";

import { useEffect } from "react";
import { recordProductView, useDeviceLists } from "@/lib/device/store";
import { useProductCards } from "@/lib/device/use-cards";
import { ProductGrid } from "./product-card";

/** Remembers that this product was opened, on this device only. Renders nothing. */
export function RecordView({ slug }: { slug: string }) {
  useEffect(() => recordProductView(slug), [slug]);
  return null;
}

/**
 * "Recently viewed" rail: up to four products the shopper opened on this device, fetched fresh.
 * Shows nothing when there are none or they cannot be loaded.
 */
export function RecentlyViewed({ exclude }: { exclude?: string }) {
  const recent = useDeviceLists()
    .recent.filter((slug) => slug !== exclude)
    .slice(0, 4);
  const cards = useProductCards(recent);
  if (cards.status !== "ready" || cards.cards.length === 0) return null;
  return (
    <section aria-labelledby="recent" className="flex flex-col gap-5 pt-12">
      <h2 id="recent" className="text-xl font-semibold tracking-tight">
        Recently viewed
      </h2>
      <ProductGrid products={cards.cards.filter((card) => card.slug !== exclude)} />
    </section>
  );
}
