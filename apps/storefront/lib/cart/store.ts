"use client";

import { useSyncExternalStore } from "react";
import { track } from "@/lib/telemetry/client";
import {
  addLine,
  CART_STORAGE_KEY,
  EMPTY_CART,
  parseCart,
  removeLine,
  setLineQuantity,
  type AddResult,
  type Cart,
  type CartLine,
} from "./cart";

const listeners = new Set<() => void>();
let cached: { text: string | null; cart: Cart } = { text: null, cart: EMPTY_CART };
/** Set when a write could not be stored: the cart then lives in memory for this page. */
let memoryOnly = false;

function read(): Cart {
  if (memoryOnly) return cached.cart;
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(CART_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, policy): the cart lives for this page only.
    return cached.cart;
  }
  if (text !== cached.text) cached = { text, cart: parseCart(text) };
  return cached.cart;
}

function write(cart: Cart) {
  const text = JSON.stringify(cart);
  cached = { text, cart };
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, text);
    memoryOnly = false;
  } catch {
    // Storage full or blocked: keep what the shopper added instead of reverting to stored text.
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the cart.
  const onStorage = (event: StorageEvent) => {
    if (event.key === CART_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The device cart. Empty during server rendering and until the browser has read storage. */
export function useCart(): Cart {
  return useSyncExternalStore(subscribe, read, () => EMPTY_CART);
}

const quantityOf = (cart: Cart, variantId: string) =>
  cart.lines.find((line) => line.variantId === variantId)?.quantity ?? 0;
/** Anonymous cart events (step 104): how many units really went in or out. */
function trackChange(variantId: string, before: number, after: number) {
  if (after > before) track({ type: "cart_add", variantId, quantity: after - before });
  else if (after < before) track({ type: "cart_remove", variantId, quantity: before - after });
}

export function addToCart(line: Omit<CartLine, "quantity">, quantity: number): AddResult {
  const before = quantityOf(read(), line.variantId);
  const result = addLine(read(), line, quantity);
  if (result.cart !== cached.cart) write(result.cart);
  trackChange(line.variantId, before, result.quantity);
  return result;
}

export function setCartQuantity(variantId: string, quantity: number): void {
  const before = quantityOf(read(), variantId);
  const next = setLineQuantity(read(), variantId, quantity);
  if (next !== cached.cart) write(next);
  trackChange(variantId, before, quantityOf(next, variantId));
}

/** Empties the cart. Called only after the API has acknowledged the order made from it. */
export function clearCart(): void {
  write(EMPTY_CART);
}

export function removeFromCart(variantId: string): void {
  const before = quantityOf(read(), variantId);
  const next = removeLine(read(), variantId);
  if (next !== cached.cart) write(next);
  trackChange(variantId, before, 0);
}
