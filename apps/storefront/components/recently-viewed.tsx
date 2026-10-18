"use client";

import { useEffect } from "react";
import { recordProductView, useDeviceLists } from "@/lib/device/store";
import { track } from "@/lib/telemetry/client";
import { useProductCards } from "@/lib/device/use-cards";
import { ProductRail } from "./product-card";

/** Remembers that this product was opened, on this device only. Renders nothing. */
export function RecordView({ slug }: { slug: string }) {
  useEffect(() => {
    recordProductView(slug);
    track({ type: "product_view", productSlug: slug });
  }, [slug]);
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
    <section className="sec" aria-labelledby="rec-h">
      <div className="sec-head">
        <div>
          <h2 className="h2" id="rec-h">
            Recently viewed
          </h2>
          <p className="sub">Saved on this device</p>
        </div>
      </div>
      <ProductRail products={cards.cards.filter((card) => card.slug !== exclude)} />
    </section>
  );
}
