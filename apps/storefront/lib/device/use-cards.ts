"use client";

import { useEffect, useState } from "react";
import { storeProductCardsResponseSchema, type StoreProductCard } from "@ih/contracts";
import { applyRenames } from "./store";

export type CardsState =
  | { status: "loading" }
  | { status: "failed" }
  /** `cards` in the order asked; `missing` are slugs the store no longer offers. */
  | { status: "ready"; cards: StoreProductCard[]; missing: string[] };

/**
 * Current cards for remembered slugs, from the same-origin API route (which checks the age
 * ticket). Nothing is shown from device memory: a product that is gone is reported as missing,
 * and a renamed one is updated in the lists.
 */
export function useProductCards(slugs: readonly string[]): CardsState {
  const key = slugs.join(",");
  const [answer, setAnswer] = useState<{ key: string; state: CardsState } | null>(null);

  useEffect(() => {
    if (!key) return;
    const asked = key.split(",");
    const controller = new AbortController();
    fetch(`/api/v1/store/product-cards?${asked.map((slug) => `slug=${slug}`).join("&")}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("cards"))))
      .then((body: unknown) => {
        const parsed = storeProductCardsResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("contract");
        const found = new Map(parsed.data.items.map((item) => [item.requested, item.card]));
        // A product remembered under both an old and its current slug is shown once.
        const shown = new Set<string>();
        setAnswer({
          key,
          state: {
            status: "ready",
            cards: asked.flatMap((slug) => {
              const card = found.get(slug);
              if (!card || shown.has(card.slug)) return [];
              shown.add(card.slug);
              return [card];
            }),
            missing: asked.filter((slug) => !found.has(slug)),
          },
        });
        applyRenames(new Map([...found].map(([requested, card]) => [requested, card.slug])));
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer({ key, state: { status: "failed" } });
      });
    return () => controller.abort();
  }, [key]);

  if (!key) return { status: "ready", cards: [], missing: [] };
  return answer?.key === key ? answer.state : { status: "loading" };
}
