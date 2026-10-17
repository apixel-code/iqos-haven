"use client";

import Link from "next/link";
import { useState } from "react";
import type { StoreProductCard } from "@ih/contracts";
import { ProductGrid } from "./product-card";

export interface PopularList {
  key: string;
  label: string;
  products: readonly StoreProductCard[];
  more: { label: string; href: string };
}

/**
 * "Popular right now" (prototype `featBox`): the lists the shop has, behind a two-way toggle
 * when there is more than one. Empty lists are left out by the caller.
 */
export function PopularProducts({ lists }: { lists: readonly PopularList[] }) {
  const [active, setActive] = useState(lists[0]?.key);
  const list = lists.find((item) => item.key === active) ?? lists[0];
  if (!list) return null;
  return (
    <section aria-labelledby="home-popular" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end sm:justify-between">
        <h2
          id="home-popular"
          className="text-[clamp(21px,3.6vw,28px)] font-semibold tracking-tight"
        >
          {lists.length > 1 ? "Popular right now" : list.label}
        </h2>
        {lists.length > 1 && (
          <div
            role="group"
            aria-label="Show"
            className="grid auto-cols-fr grid-flow-col rounded-pill bg-surface-2 p-1 sm:inline-grid"
          >
            {lists.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.key === list.key}
                onClick={() => setActive(item.key)}
                className="h-9 rounded-pill px-4 text-sm font-medium text-ink-2 aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ProductGrid products={list.products.slice(0, 8)} />
      <Link
        href={list.more.href}
        prefetch={false}
        className="self-center text-sm font-medium underline-offset-2 hover:underline"
      >
        {list.more.label} →
      </Link>
    </section>
  );
}
