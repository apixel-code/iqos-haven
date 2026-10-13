"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { storeCartLinesResponseSchema, type StoreCartLine } from "@ih/contracts";
import { cartView } from "./cart";
import { useCart } from "./store";

/** Outcome of the latest refresh, tagged with the variant set it was for. */
type Outcome = { key: string; ok: boolean } | null;
type Known = ReadonlyMap<string, StoreCartLine | null>;

/**
 * The device cart with what the API currently says about its lines (step 62, ADR 0031). Shared
 * by the cart page and the checkout page: the API (which checks the age ticket) is asked each
 * time the set of variants changes, and again when `recheck` is called.
 */
export function useFreshCart() {
  const cart = useCart();
  // Only the set of variants matters for the refresh, not their quantities.
  const key = useMemo(
    () =>
      cart.lines
        .map((line) => line.variantId)
        .sort()
        .join(","),
    [cart.lines],
  );
  // Latest server answer per variant. Kept across refreshes: what the server said about a
  // variant applies for as long as it is in the cart.
  const [known, setKnown] = useState<Known>(new Map());
  const [outcome, setOutcome] = useState<Outcome>(null);
  // Bumped when the quote says a line is no longer offered, to refresh the lines at once.
  const [refresh, setRefresh] = useState(0);
  const recheck = useCallback(() => setRefresh((count) => count + 1), []);
  // False while the server-rendered frame is shown; the device cart is read after hydration.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const ids = key.split(",");
    fetch(`/api/v1/store/cart/lines?${ids.map((id) => `variant=${id}`).join("&")}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("refresh"))))
      .then((body: unknown) => {
        const parsed = storeCartLinesResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("contract");
        const returned = new Map(parsed.data.lines.map((line) => [line.variantId, line]));
        // Every requested ID now has an answer: its line, or null for "not offered".
        setKnown((previous) => {
          const next = new Map(previous);
          for (const id of ids) next.set(id, returned.get(id) ?? null);
          return next;
        });
        setOutcome({ key, ok: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setOutcome({ key, ok: false });
      });
    return () => controller.abort();
  }, [key, refresh]);

  return {
    cart,
    known,
    view: cartView(cart, known),
    failed: outcome?.key === key && !outcome.ok,
    mounted,
    recheck,
  };
}
