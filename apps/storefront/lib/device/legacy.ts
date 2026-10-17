/** Keys the prototype used for checkout details and the last order (CLAUDE.md trap). */
export const LEGACY_CHECKOUT_KEYS = ["co", "lastOrder"] as const;

/**
 * Removes checkout details an earlier prototype build may have left on this device. Checkout
 * name, phone and address are never stored by this site; this makes sure old copies go too.
 * A storage that is missing or blocked is skipped: there is nothing to remove from it.
 */
export function clearLegacyCheckoutKeys(
  storages: ReadonlyArray<() => Pick<Storage, "removeItem">>,
): void {
  for (const open of storages) {
    let storage: Pick<Storage, "removeItem">;
    try {
      storage = open();
    } catch {
      continue;
    }
    for (const key of LEGACY_CHECKOUT_KEYS) {
      try {
        storage.removeItem(key);
      } catch {
        // Blocked mid-way: the rest is still tried.
      }
    }
  }
}
