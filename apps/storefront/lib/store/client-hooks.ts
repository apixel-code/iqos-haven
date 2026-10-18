"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  storeBrandsResponseSchema,
  storeSuggestResponseSchema,
  type StoreBrandsResponse,
  type StoreSuggestResponse,
} from "@ih/contracts";

/**
 * Small client reads shared by the header search and the mobile sheets. Both go to the
 * same-origin API route, which checks the age ticket itself; a failure only means "nothing
 * to show" or a retry, never a page error.
 */
export type BrandsState =
  | { state: "idle" | "loading" | "failed" }
  | { state: "ready"; items: StoreBrandsResponse["items"] };

/** Brands with products, read on demand (when a sheet first opens), not on every page. */
export function useStoreBrands() {
  const [brands, setBrands] = useState<BrandsState>({ state: "idle" });
  // The latest state for `ensure`, which runs from event handlers.
  const current = useRef<BrandsState["state"]>("idle");
  const set = useCallback((next: BrandsState) => {
    current.current = next.state;
    setBrands(next);
  }, []);
  const load = useCallback(() => {
    set({ state: "loading" });
    fetch("/api/v1/store/brands", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("brands"))))
      .then((body: unknown) => {
        const parsed = storeBrandsResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("contract");
        set({
          state: "ready",
          items: parsed.data.items.filter((brand) => brand.productCount > 0),
        });
      })
      .catch(() => set({ state: "failed" }));
  }, [set]);
  /** Loads when nothing is loaded yet or the last try failed. */
  const ensure = useCallback(() => {
    if (current.current === "idle" || current.current === "failed") load();
  }, [load]);
  return { brands, load, ensure };
}

/**
 * Suggestions for what is typed (two or more characters), after a short pause. Answers to an
 * older keystroke and anything off-contract are ignored.
 */
export function useSuggestions(value: string): StoreSuggestResponse | null {
  const [answer, setAnswer] = useState<{ term: string; data: StoreSuggestResponse } | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    const term = value.trim();
    if (term.length < 2) return;
    const request = ++latest.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v1/store/search/suggest?q=${encodeURIComponent(term.slice(0, 200))}`, {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          const parsed = storeSuggestResponseSchema.safeParse(body);
          if (request === latest.current && parsed.success) setAnswer({ term, data: parsed.data });
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);
  return answer !== null && answer.term === value.trim() ? answer.data : null;
}
