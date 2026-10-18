"use client";

import { useSyncExternalStore } from "react";

/**
 * The prototype's toast (`toast`, parity G-S10): one short message at a time, with an optional
 * action ("Undo", "View saved"). It disappears by itself; with an action it stays longer, and a
 * pointer or focus on it holds it (WCAG 2.2.1).
 *
 * A modal sheet is in the browser's top layer, above anything on the page, so every open sheet
 * has its own toast host and only the topmost host shows the toast.
 */
export interface Toast {
  id: number;
  title: string;
  sub?: string;
  /** A small picture (a product thumbnail). */
  image?: string | null;
  action?: { label: string; run: () => void };
}
export const TOAST_MS = 3200;
export const TOAST_ACTION_MS = 6000;

let current: Toast | null = null;
let next = 1;
let hosts: number[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Shows a toast in place of any other. */
export function toast(message: Omit<Toast, "id">) {
  current = { ...message, id: next++ };
  emit();
}
/** Removes the toast `id` if it is still the one shown. */
export function dismissToast(id: number) {
  if (current?.id !== id) return;
  current = null;
  emit();
}
export function useToast(): Toast | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** A host registers while mounted; the last one registered is the topmost. */
export function registerToastHost(id: number) {
  hosts = [...hosts.filter((host) => host !== id), id];
  emit();
  return () => {
    hosts = hosts.filter((host) => host !== id);
    emit();
  };
}
export function useTopToastHost(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => hosts.at(-1) ?? null,
    () => null,
  );
}
let hostIds = 1;
export const newToastHostId = () => hostIds++;
