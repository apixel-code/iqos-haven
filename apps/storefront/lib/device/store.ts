"use client";

import { useSyncExternalStore } from "react";
import { track } from "@/lib/telemetry/client";
import {
  EMPTY_LISTS,
  LISTS_STORAGE_KEY,
  parseLists,
  recordView,
  removeFrom,
  renameIn,
  toggleCompare,
  toggleSaved,
  type DeviceLists,
} from "./lists";

const listeners = new Set<() => void>();
let cached: { text: string | null; lists: DeviceLists } = { text: null, lists: EMPTY_LISTS };
/** Set when a write could not be stored: the lists then live in memory for this page. */
let memoryOnly = false;

function read(): DeviceLists {
  if (memoryOnly) return cached.lists;
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(LISTS_STORAGE_KEY);
  } catch {
    return cached.lists;
  }
  if (text !== cached.text) cached = { text, lists: parseLists(text) };
  return cached.lists;
}

function write(lists: DeviceLists) {
  if (lists === cached.lists) return;
  const text = JSON.stringify(lists);
  cached = { text, lists };
  try {
    window.localStorage.setItem(LISTS_STORAGE_KEY, text);
    memoryOnly = false;
  } catch {
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LISTS_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The device lists. Empty during server rendering and until the browser has read storage. */
export function useDeviceLists(): DeviceLists {
  return useSyncExternalStore(subscribe, read, () => EMPTY_LISTS);
}

/**
 * The saved list itself stays on this device; only an anonymous add or remove is reported
 * (step 104), so the shop can count interest in a product, never whose list it is.
 */
export function toggleSavedProduct(slug: string) {
  const wasSaved = read().saved.includes(slug);
  const result = toggleSaved(read(), slug);
  write(result.lists);
  if (result.saved) track({ type: "wishlist_add", productSlug: slug });
  else if (wasSaved) track({ type: "wishlist_remove", productSlug: slug });
  return result;
}
export function toggleCompareProduct(slug: string) {
  const result = toggleCompare(read(), slug);
  write(result.lists);
  return result;
}
export const recordProductView = (slug: string) => write(recordView(read(), slug));
export function removeFromList(list: "saved" | "compare" | "recent", slug: string) {
  const wasSaved = list === "saved" && read().saved.includes(slug);
  write(removeFrom(read(), list, slug));
  if (wasSaved) track({ type: "wishlist_remove", productSlug: slug });
}
export const applyRenames = (renames: ReadonlyMap<string, string>) =>
  write(renameIn(read(), renames));
