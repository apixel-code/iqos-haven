import { describe, expect, it } from "vitest";
import type { ProductVariantsResponse } from "@ih/contracts";
import {
  combinations,
  describeAttributes,
  missingCombinations,
  parseOptionValues,
  suggestSku,
} from "./variants";

const view = (
  options: ProductVariantsResponse["options"],
  attributes: Array<Record<string, string>> = [],
): ProductVariantsResponse => ({
  productId: "0199c0de-0000-7000-8000-000000000001",
  productVersion: 1,
  options,
  variants: attributes.map((a, i) => ({
    id: `0199c0de-0000-7000-8000-00000000001${i}`,
    sku: "S" + i,
    attributes: a,
    priceOverrideFils: null,
    stockOnHand: 0,
    lowStockThreshold: 0,
    active: true,
    isDefault: i === 0,
    version: 1,
    updatedAt: new Date().toISOString(),
  })),
});

describe("variant helpers", () => {
  it("parses option values canonically and without duplicates", () => {
    expect(parseOptionValues("Grape Ice, mint\nMINT\n\n 20 mg ")).toEqual([
      "grape ice",
      "mint",
      "20 mg",
    ]);
  });

  it("enumerates combinations and finds the missing ones", () => {
    const options = [
      { name: "flavour" as const, values: ["mint", "grape"] },
      { name: "nicotine" as const, values: ["20 mg", "50 mg"] },
    ];
    expect(combinations(options)).toHaveLength(4);
    expect(combinations([])).toEqual([{}]);
    const missing = missingCombinations(view(options, [{ nicotine: "20 mg", flavour: "mint" }]));
    expect(missing).toHaveLength(3);
    expect(missing).not.toContainEqual({ flavour: "mint", nicotine: "20 mg" });
  });

  it("suggests valid uppercase SKUs and readable labels", () => {
    expect(suggestSku("orbe-halo-7k", { flavour: "grape ice", nicotine: "20 mg" })).toBe(
      "ORBE-HALO-7K-GRAPE-ICE-20-MG",
    );
    expect(suggestSku("x".repeat(70), {})).toHaveLength(64);
    // Long slugs keep the values and a distinct position suffix within 64 characters.
    const long = "very-long-product-slug-".repeat(4);
    const a = suggestSku(long, { flavour: "grape ice", nicotine: "20 mg" }, 0);
    const b = suggestSku(long, { flavour: "grape ice", nicotine: "50 mg" }, 1);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toMatch(/GRAPE-ICE-20-MG-V01$/);
    expect(b).toMatch(/-V02$/);
    // Non-Latin values strip to nothing; the suffix still keeps suggestions apart.
    expect(suggestSku("nova", { flavour: "نعناع" }, 0)).not.toBe(
      suggestSku("nova", { flavour: "فراولة" }, 1),
    );
    for (const sku of [a, b, suggestSku("nova", { flavour: "نعناع" }, 0)])
      expect(sku).toMatch(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);
    expect(describeAttributes({ flavour: "mint" })).toBe("Flavour: mint");
    expect(describeAttributes({})).toBe("Single variant (no options)");
  });
});
