import type { LaunchFacts } from "@ih/db";
import { describe, expect, it } from "vitest";
import { evaluateLaunch, formatLaunch } from "./launch-check";

const shipped = ["20261008000000_a", "20261009000000_b"];
const ready: LaunchFacts = {
  migrations: { applied: [...shipped], unfinished: 0 },
  activeOwners: 1,
  testAccounts: 0,
  settings: {
    store: { name: "Iqos Haven", domain: "iqoshaven.com" },
    contact: { email: null, phone: "+971500000000" },
    whatsappNumber: "+971500000000",
    newOrderEmail: true,
    seoIndexing: "public_pages",
    delivery: { flatFeeFils: 2500, etaText: "Within 2 hours" },
  },
  activeAreas: 1,
  publishedProducts: 3,
  publishedWithoutActiveOption: 0,
  publishedWithoutImage: 0,
  publishedSoldOut: 0,
  ledgerMismatches: 0,
  demoCoupons: 0,
  fixtureCatalogue: 0,
  deadEffects: 0,
};
const levels = (facts: LaunchFacts) =>
  Object.fromEntries(evaluateLaunch(facts, shipped).map((r) => [r.name, r.level]));

describe("launch check (step 124)", () => {
  it("passes a ready database", () => {
    const results = evaluateLaunch(ready, shipped);
    expect(results.every((r) => r.level === "PASS")).toBe(true);
    expect(formatLaunch(results)).toMatchObject({ exitCode: 0 });
    expect(formatLaunch(results).text).toMatch(/Ready to launch\.$/);
  });

  it("blocks on what a shopper or the Owner would hit", () => {
    const facts: LaunchFacts = {
      ...ready,
      migrations: { applied: [shipped[0]!], unfinished: 1 },
      activeOwners: 0,
      testAccounts: 2,
      settings: {
        ...ready.settings,
        store: { name: "Iqos Haven", domain: "shop.iqoshaven.test" },
        contact: { email: null, phone: null },
        whatsappNumber: null,
        delivery: null,
      },
      activeAreas: 0,
      publishedProducts: 0,
      publishedWithoutActiveOption: 1,
      publishedWithoutImage: 1,
      ledgerMismatches: 1,
      demoCoupons: 1,
      fixtureCatalogue: 1,
    };
    const results = evaluateLaunch(facts, shipped);
    const failed = results.filter((r) => r.level === "FAIL").map((r) => r.name);
    expect(failed).toEqual([
      "migrations are all applied",
      "an active Owner exists",
      "no staff account on a test domain",
      "store name and domain are set",
      "a contact email or phone is set",
      "the WhatsApp number is set (BI-09)",
      "the delivery fee and promise are set",
      "at least one delivery area is active",
      "at least one product is published",
      "every published product has an active option",
      "every published product has an image",
      "stock matches the stock ledger",
      "no prototype demo coupon codes",
      "no fixture catalogue records",
    ]);
    expect(results[0]!.detail).toBe("1 not applied (first: 20261009000000_b), 1 unfinished");
    const output = formatLaunch(results);
    expect(output.exitCode).toBe(1);
    expect(output.text).toMatch(/Not ready: 14 blocking, 0 to review\.$/);
  });

  it("only warns on choices the Owner may make on purpose", () => {
    const result = levels({
      ...ready,
      migrations: null,
      publishedSoldOut: 2,
      deadEffects: 1,
      settings: { ...ready.settings, newOrderEmail: false, seoIndexing: null },
    });
    expect(result).toMatchObject({
      "migrations are all applied": "WARN",
      "published products have stock": "WARN",
      "new-order email alerts are on": "WARN",
      "search indexing is open (BI-05)": "WARN",
      "no dead background effects": "WARN",
    });
    const output = formatLaunch(evaluateLaunch({ ...ready, publishedSoldOut: 1 }, shipped));
    expect(output).toMatchObject({ exitCode: 0 });
    expect(output.text).toMatch(/Ready to launch, with 1 to review\.$/);
  });

  it("treats reserved domains as not set", () => {
    for (const domain of ["example.com", "iqoshaven.test", "shop.localhost", "a.invalid"])
      expect(
        levels({ ...ready, settings: { ...ready.settings, store: { name: "x", domain } } })[
          "store name and domain are set"
        ],
      ).toBe("FAIL");
    expect(
      levels({
        ...ready,
        settings: { ...ready.settings, store: { name: "x", domain: "testshop.ae" } },
      })["store name and domain are set"],
    ).toBe("PASS");
  });
});
