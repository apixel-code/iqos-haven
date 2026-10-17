"use client";

import { useEffect } from "react";
import { clearLegacyCheckoutKeys } from "@/lib/device/legacy";

/**
 * Clears checkout details an earlier prototype build may have left on this device. Rendered on
 * every page, including the age check, so it does not depend on using the cart.
 */
export function LegacyCleanup() {
  useEffect(() => {
    clearLegacyCheckoutKeys([() => window.localStorage, () => window.sessionStorage]);
  }, []);
  return null;
}
