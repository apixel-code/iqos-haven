"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the cart sheet is open (parity G-S1, ADR 0082). One sheet lives in the store shell;
 * adding to the cart opens it from anywhere on the page, and the sheet closes it. Each open
 * request has its own revision, so an add right after closing reopens the sheet even before the
 * dialog's (asynchronous) close event has been handled (step 120).
 */
type SheetState = { open: boolean; revision: number };
let state: SheetState = { open: false, revision: 0 };
const listeners = new Set<() => void>();
const set = (next: SheetState) => {
  state = next;
  for (const listener of listeners) listener();
};
export const openCartSheet = () => set({ open: true, revision: state.revision + 1 });
export const closeCartSheet = () => {
  if (state.open) set({ ...state, open: false });
};
const CLOSED: SheetState = { open: false, revision: 0 };
export function useCartSheet(): SheetState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => CLOSED,
  );
}
