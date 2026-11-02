import { describe, expect, it } from "vitest";
import type { ProductResponse } from "@ih/contracts";
import { FormValidationError } from "./management";
import {
  extraSpecs,
  flavourProfiles,
  formatExtraSpecs,
  formatFlavourProfiles,
  productCreateCommand,
  productTypeChoices,
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

  it("builds heated-tobacco specs with no puff count (ADR 0101)", () => {
    const device = productCreateCommand(
      data({
        ...base,
        type: "device",
        puffCount: "6000",
        "specs.compatibleSticks": "TEREA sticks only",
        "specs.sessionsPerCharge": "20",
      }),
      false,
    );
    expect(device).toMatchObject({
      type: "device",
      puffCount: null,
      specs: { compatibleSticks: "TEREA sticks only", sessionsPerCharge: 20, extra: [] },
    });
    const sticks = productCreateCommand(
      data({
        ...base,
        type: "sticks",
        "specs.origin": "Japan",
        "specs.sticksPerPack": "20",
        "specs.packsPerUnit": "10",
      }),
      false,
    );
    expect(sticks).toMatchObject({
      type: "sticks",
      puffCount: null,
      specs: { origin: "Japan", sticksPerPack: 20, packsPerUnit: 10 },
    });
    expect(() =>
      productCreateCommand(data({ ...base, type: "sticks", "specs.packsPerUnit": "0" }), false),
    ).toThrow(FormValidationError);
  });

  it("reads and writes TEREA flavour profiles one per line (ADR 0103)", () => {
    const typed =
      "Sun Pearl | 3 | 4 | 3 | capsule | Watermelon | when crushed\n\namber | 4 | 4 | 0 | -";
    const rows = flavourProfiles(typed);
    expect(rows).toEqual([
      {
        flavour: "sun pearl",
        body: 3,
        intensity: 4,
        cooling: 3,
        capsule: true,
        notes: "Watermelon | when crushed",
      },
      { flavour: "amber", body: 4, intensity: 4, cooling: 0, capsule: false },
    ]);
    expect(flavourProfiles(formatFlavourProfiles(rows))).toEqual(rows);
    for (const bad of [
      "amber | 0 | 4 | 0 | -",
      "amber | 4 | 4 | 6 | -",
      "amber | 4 | 4 | 0",
      "| 3 | 3 | 3 | -",
    ])
      expect(() => flavourProfiles(bad)).toThrow(FormValidationError);
    const sticks = productCreateCommand(
      data({ ...base, type: "sticks", "specs.profiles": "amber | 4 | 4 | 0 | -" }),
      false,
    );
    expect(sticks.specs).toMatchObject({
      profiles: [{ flavour: "amber", body: 4, intensity: 4, cooling: 0, capsule: false }],
    });
  });

  it("offers only heated-tobacco types for new products and keeps a stored vape type", () => {
    expect(productTypeChoices()).toEqual(["device", "sticks"]);
    expect(productTypeChoices("sticks")).toEqual(["device", "sticks"]);
    expect(productTypeChoices("kit")).toEqual(["device", "sticks", "kit"]);
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
