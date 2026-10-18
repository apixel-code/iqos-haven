"use client";

import { useSyncExternalStore } from "react";

/**
 * The admin prototype's confirmation dialog (`confirmDlg`, parity G-A13) in place of
 * `window.confirm`: `await confirmDialog({...})` resolves true for the confirm button and false
 * for Cancel, Escape or the backdrop. One question at a time; a new one answers the old one no.
 */
export interface ConfirmRequest {
  title: string;
  body?: string;
  /** The confirm button's label; "Confirm" when left out. */
  ok?: string;
  cancel?: string;
  /** A destructive action: red button and the alert icon. */
  danger?: boolean;
}
type Pending = ConfirmRequest & { id: number; resolve: (answer: boolean) => void };

let pending: Pending | null = null;
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...request, id: next++, resolve };
    emit();
  });
}
export function answerConfirm(id: number, answer: boolean) {
  if (pending?.id !== id) return;
  const { resolve } = pending;
  pending = null;
  emit();
  resolve(answer);
}
export function usePendingConfirm(): Pending | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => null,
  );
}
