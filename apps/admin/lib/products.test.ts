import { describe, expect, it } from "vitest";
import type { ProductResponse } from "@ih/contracts";
import { FormValidationError } from "./management";
import {
  extraSpecs,
  formatExtraSpecs,
  productCreateCommand,
  productUpdateCommand,
} from "./products";

const data = (entries: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(entries)) result.set(key, value);
  return result;
};
const brandId = "0199c0de-0000-7000-8000-000000000001";
const categoryId = "0199c0de-0000-7000-8000-000000000002";
const base = { name: "Nova 6K", slug: "nova-6k", brandId, categoryId, price: "49.50" };

describe("product form commands", () => {
  it("converts AED text to integer fils and builds typed disposable specs", () => {
    const command = productCreateCommand(
      data({
        ...base,
        type: "disposable",
        puffCount: "6000",
        compareAt: "59",
        "specs.liquidMl": "12.5",
        "specs.batteryMah": "650",
        "specs.rechargeable": "on",
        "specs.extra": "Flavours: Mint, Grape",
        isNew: "on",
      }),
      false,
    );
    expect(command).toMatchObject({
      type: "disposable",
      puffCount: 6000,
      basePriceFils: 4950,
      compareAtPriceFils: 5900,
      isNew: true,
      specs: {
        liquidMl: "12.5",
        batteryMah: 650,
        rechargeable: true,
        extra: [{ label: "Flavours", value: "Mint, Grape" }],
      },
    });
    expect(command).not.toHaveProperty("seo");
  });

  it("drops disposable-only fields for kits and sends SEO only when allowed", () => {
    const command = productCreateCommand(
      data({ ...base, type: "kit", puffCount: "6000", "specs.coilOhm": "0.8", "seo.title": "T" }),
      true,
    );
    expect(command).toMatchObject({ type: "kit", puffCount: null, specs: { coilOhm: "0.8" } });
    expect(command.seo).toEqual({ title: "T", description: null });
  });

  it("carries the current version on update", () => {
    const row = { version: 4 } as ProductResponse;
    expect(productUpdateCommand(row, data({ ...base, type: "kit" }), false).version).toBe(4);
  });

  it("rejects bad money, compare-at, specs and puff values before sending", () => {
    for (const overrides of <Array<Record<string, string>>>[
      { price: "49.555" },
      { price: "-1" },
      { compareAt: "40" },
      { puffCount: "6k" },
      { "specs.liquidMl": "12.55" },
      { "specs.extra": "no separator" },
    ])
      expect(() =>
        productCreateCommand(data({ ...base, type: "disposable", ...overrides }), false),
      ).toThrow(FormValidationError);
  });

  it("round-trips extra specification rows", () => {
    const rows = [{ label: "Flavours", value: "Mint: cool" }];
    expect(extraSpecs(formatExtraSpecs(rows))).toEqual(rows);
  });
});
