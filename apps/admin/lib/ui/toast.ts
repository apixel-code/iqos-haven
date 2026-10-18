"use client";

import { useSyncExternalStore } from "react";

/**
 * The admin prototype's toast (`toast`, parity G-A13): up to three short messages, newest last.
 * "ok" and "info" are announced politely, "err" assertively. A message disappears by itself
 * (3.8 s, or 6.5 s with an action) unless a pointer or focus holds it (WCAG 2.2.1).
 *
 * A modal layer is in the browser's top layer, above anything on the page, so every open layer
 * has its own toast host and only the topmost host shows the toasts.
 */
export type ToastKind = "ok" | "err" | "info";
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; run: () => void };
}
export const TOAST_MS = 3800;
export const TOAST_ACTION_MS = 6500;
const MAX = 3;

let toasts: readonly Toast[] = [];
let next = 1;
let hosts: number[] = [];
let hostIds = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const NONE: readonly Toast[] = [];

export function toast(
  message: string,
  options: { kind?: ToastKind; action?: Toast["action"] } = {},
) {
  const item: Toast = { id: next++, message, kind: options.kind ?? "ok" };
  if (options.action) item.action = options.action;
  toasts = [...toasts, item].slice(-MAX);
  emit();
}
export function dismissToast(id: number) {
  if (!toasts.some((item) => item.id === id)) return;
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}
export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => NONE,
  );
}

export const newToastHostId = () => hostIds++;
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
