"use client";

import { useEffect } from "react";

/** Keys the prototype used for checkout details and the last order. */
const LEGACY_KEYS = ["co", "lastOrder"];

/**
 * Removes checkout details an earlier prototype build may have left on this device. Checkout
 * name, phone and address are never stored by this site; this makes sure old copies go too.
 * Rendered on every page, including the age check, so it does not depend on using the cart.
 */
export function LegacyCleanup() {
  useEffect(() => {
    for (const storage of [window.localStorage, window.sessionStorage])
      for (const key of LEGACY_KEYS) {
        try {
          storage.removeItem(key);
        } catch {
          // Storage blocked: there is nothing to remove.
        }
      }
  }, []);
  return null;
}
