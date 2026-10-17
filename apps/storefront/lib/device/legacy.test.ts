import { describe, expect, it } from "vitest";
import { clearLegacyCheckoutKeys, LEGACY_CHECKOUT_KEYS } from "./legacy";

/** An in-memory Storage with what the prototype left behind (step 118). */
function planted() {
  const values = new Map<string, string>([
    ["co", JSON.stringify({ name: "Old Buyer", phone: "+971501234567", building: "Old Villa" })],
    ["lastOrder", JSON.stringify({ id: "IH-000001", phone: "+971501234567" })],
    ["ih_cart_v1", "[]"],
    ["ih_lists_v1", "{}"],
  ]);
  return { values, removeItem: (key: string) => void values.delete(key) };
}

describe("legacy checkout storage cleanup", () => {
  it("removes the prototype's checkout and last-order copies from both storages, nothing else", () => {
    const local = planted();
    const session = planted();
    clearLegacyCheckoutKeys([() => local, () => session]);
    for (const storage of [local, session]) {
      for (const key of LEGACY_CHECKOUT_KEYS) expect(storage.values.has(key)).toBe(false);
      expect([...storage.values.keys()].sort()).toEqual(["ih_cart_v1", "ih_lists_v1"]);
      expect([...storage.values.values()].join()).not.toMatch(/971|Old Buyer|Villa/);
    }
  });

  it("carries on when a storage is unavailable or refuses", () => {
    const session = planted();
    clearLegacyCheckoutKeys([
      () => {
        throw new Error("SecurityError: storage blocked");
      },
      () => ({
        removeItem: () => {
          throw new Error("QuotaExceeded");
        },
      }),
      () => session,
    ]);
    expect(session.values.has("co")).toBe(false);
    expect(session.values.has("lastOrder")).toBe(false);
  });
});
