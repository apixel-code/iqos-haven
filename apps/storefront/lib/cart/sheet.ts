"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the cart sheet is open (parity G-S1, ADR 0082). One sheet lives in the store shell;
 * adding to the cart opens it from anywhere on the page, and the sheet closes it.
 */
let open = false;
const listeners = new Set<() => void>();
const set = (value: boolean) => {
  if (open === value) return;
  open = value;
  for (const listener of listeners) listener();
};
export const openCartSheet = () => set(true);
export const closeCartSheet = () => set(false);
export function useCartSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}
