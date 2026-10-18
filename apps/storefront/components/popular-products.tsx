"use client";

import { useState } from "react";
import type { StoreProductCard } from "@ih/contracts";
import { MoreLink } from "./home-sections";
import { ProductRail } from "./product-card";

export interface PopularList {
  key: string;
  label: string;
  products: readonly StoreProductCard[];
  more: { label: string; href: string };
}

/**
 * "Popular right now" (prototype `featBox`, ADR 0097): the lists the shop has, behind the
 * prototype's segmented toggle when there is more than one. Empty lists are left out by the
 * caller.
 */
export function PopularProducts({ lists }: { lists: readonly PopularList[] }) {
  const [active, setActive] = useState(lists[0]?.key);
  const list = lists.find((item) => item.key === active) ?? lists[0];
  if (!list) return null;
  return (
    <section className="sec" style={{ paddingTop: 0 }} aria-labelledby="feat-h">
      <div className="sec-head tabs-head">
        <div>
          <h2 className="h2" id="feat-h">
            {lists.length > 1 ? "Popular right now" : list.label}
          </h2>
        </div>
        {lists.length > 1 && (
          <div className="seg" role="group" aria-label="Product list">
            {lists.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.key === list.key}
                onClick={() => setActive(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ProductRail products={list.products.slice(0, 4)} />
      <div style={{ marginTop: 22, display: "flex", justifyContent: "center" }}>
        <MoreLink href={list.more.href}>{list.more.label}</MoreLink>
      </div>
    </section>
  );
}
